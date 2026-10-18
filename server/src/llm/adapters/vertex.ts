import { ChatVertexAI } from '@langchain/google-vertexai';
import { RunnableLambda } from '@langchain/core/runnables';
import type { TaskClients, TaskSpecs } from '../tasks.js';
import { logger } from '../../logger.js';
import { LlmBlockedError, LlmConfigError, type ChatLlmConfig } from '../types.js';

/**
 * Vertex AI — Gemini *and* Claude. "Vertex or Gemini" is a category error; the
 * real distinction is which API serves the model, and this is the standard
 * endpoint surface, which carries the regional residency guarantee.
 *
 * Two residency controls, both configuration-level (SECURITY.md P8, M-8):
 *
 *  1. The endpoint and region must be stated explicitly. Nothing defaults, so
 *     an instance cannot end up on a global endpoint by omission.
 *  2. Construction fails if a Google API key is present in the environment *at
 *     all*. This is the one that matters: with `GOOGLE_API_KEY` set, the
 *     library reads it even though none was passed, `isApiKey` forces the
 *     platform to "gai", and the request goes to
 *     `https://aiplatform.googleapis.com/v1/publishers/google/models/...` —
 *     global host, configured endpoint dropped, no region in the path.
 *     Reproduced against the installed version, not inferred.
 *
 * What is deliberately *not* here: an assertion on the shape of the outgoing
 * request URL. An earlier version wrapped the library's internal HTTP client to
 * check the host and a `/locations/<region>/` path segment on every call. That
 * encoded Google's URL scheme as a security control — it would mean nothing for
 * an Azure or Bedrock endpoint, where there is no region token to look for —
 * and it coupled us to a library internal that the API-key path bypasses
 * anyway. Verifying residency against the provider's own request logs on first
 * deployment is the check that actually generalises; see
 * docs/deployment-gcp.md.
 */

/**
 * The archive is clinical documents: a scanned page can mention an injury, a medication overdose, a
 * sexual-health result or a body part, and Gemini's default filters then refuse the page ("Prompt
 * blocked: SAFETY") and Spine is left with an unread page. Nothing here is generated for anyone else
 * to see, so the configurable filters are turned off. Google's own non-configurable blocks stay.
 */
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map(category => ({ category, threshold: 'BLOCK_NONE' }));

/**
 * The smallest thinking budget the model takes. Flash models accept 0; the Pro models refuse it (a 400)
 * and have a floor of 128 tokens, which is as close to off as they go.
 */
const thinkingBudgetFor = (model: string): number => (/-pro\b/i.test(model) ? 128 : 0);

/** Environment variables whose mere presence can reroute Google traffic. */
const API_KEY_VARS = ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'] as const;

export function createVertexChat(
  config: ChatLlmConfig,
  tasks: TaskSpecs,
): TaskClients {
  const endpoint = config.endpoint;
  if (!endpoint) {
    throw new LlmConfigError(
      'SPINE_LLM_PROVIDER=vertex requires SPINE_LLM_ENDPOINT — residency is a property of the ' +
        'endpoint, so there is deliberately no default (e.g. aiplatform.eu.rep.googleapis.com)',
    );
  }
  if (!config.region) {
    throw new LlmConfigError(
      'SPINE_LLM_PROVIDER=vertex requires SPINE_LLM_REGION (e.g. eu). Stated rather than ' +
        'parsed out of the endpoint, because not every provider puts one there',
    );
  }
  if (!config.project) {
    throw new LlmConfigError('SPINE_LLM_PROVIDER=vertex requires SPINE_LLM_PROJECT');
  }

  const present = API_KEY_VARS.filter(name => (process.env[name] ?? '').length > 0);
  if (present.length > 0) {
    throw new LlmConfigError(
      `${present.join(', ')} is set, which makes this library ignore the configured endpoint ` +
        'and region and call the global one instead. Remove it from the environment and ' +
        'authenticate with a service account via GOOGLE_APPLICATION_CREDENTIALS (SECURITY.md M-8)',
    );
  }

  // One client per task: Google names the token cap `maxOutputTokens`, and it
  // is a constructor option. `endpoint` is the typed option name; `apiEndpoint`
  // also works at runtime but is not declared.
  //
  // Gemini counts its thinking against the output cap, so a task that needs none asks for it off. Models disagree
  // on how: some take `thinkingBudget: 0` and refuse `thinkingLevel: MINIMAL` (a 400), and some do the reverse,
  // or take the budget for text and refuse it beside an image. Which one a model wants is not something to
  // guess from its name, so the budget goes first and a 400 is tried once more with the level; the one that
  // worked is used from then on. Claude on Vertex has no such option.
  const gemini = /^gemini/i.test(config.model);
  const thinkingVariants: Array<Record<string, unknown>> = [{ thinkingBudget: thinkingBudgetFor(config.model) }, { thinkingLevel: 'MINIMAL' }];
  let variant = 0;

  const clients = {} as TaskClients;
  for (const task of Object.values(tasks)) {
    const clientWith = (thinking: Record<string, unknown>) => new ChatVertexAI({
      model: config.model,
      location: config.region,
      endpoint,
      maxOutputTokens: task.maxTokens,
      ...(gemini ? { safetySettings: SAFETY_SETTINGS } : {}),
      ...(task.reasoning === 'none' && gemini ? thinking : {}),
      maxRetries: config.maxRetries,
      authOptions: { projectId: config.project },
    }).withStructuredOutput(task.jsonSchema, { name: task.name });
    const structured = thinkingVariants.map(clientWith);
    const canSwitch = task.reasoning === 'none' && gemini;

    type Input = Parameters<(typeof structured)[number]['invoke']>[0];
    const call = async (input: Input) => {
      try {
        return await structured[variant].invoke(input);
      } catch (err) {
        // The library throws these as an error of a class it does not export, worded "Finish reason: RECITATION",
        // "Prompt blocked: SAFETY": the model refused these words. Said in the seam's terms.
        if (err instanceof Error && /^(Finish reason|Prompt blocked): /.test(err.message)) throw new LlmBlockedError(err.message);
        if (!canSwitch || !(err instanceof Error) || !/status code 400/.test(err.message)) throw err;
        const other = 1 - variant;
        try {
          const result = await structured[other].invoke(input);
          variant = other;
          (config.logger ?? logger).info('the model took the other way of turning thinking off', { model: config.model, setting: Object.keys(thinkingVariants[other])[0] });
          return result;
        } catch {
          throw err; // the request is wrong for another reason; the first error is the one that says so
        }
      }
    };
    clients[task.name] = RunnableLambda.from(call);
  }

  return clients;
}
