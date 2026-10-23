import { RunnableLambda } from '@langchain/core/runnables';
import { AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatVertexAI } from '@langchain/google-vertexai';
import type { TaskClients, TaskSpecs } from '../tasks.js';
import { logger } from '../../logger.js';
import { LlmBlockedError, type ChatLlmConfig } from '../types.js';

/**
 * What both ends share of Vertex AI: the server calls Google with its own credential, and the device calls it through the relay
 * (docs/crypto-design.md), and both need the same safety settings, the same way of turning thinking off, the same streaming fix and the
 * same handling of a refusal. They differ only in the class that makes the request, which is handed in.
 */
type ChatCtor = new (fields: any) => ChatVertexAI; // eslint-disable-line @typescript-eslint/no-explicit-any

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

/**
 * The agent's model, made safe to stream. Gemini 3 signs what it thought before a function call, and wants the signature sent
 * back with the call when the tool's result is returned (without it: 400 "Function call is missing a thought_signature").
 * The library keeps one signature per *part* of a message and sends them back only if their number equals the number of parts
 * it builds from the message. Read in one piece that holds; read as a stream, every chunk brings its own list (the call's, and
 * an empty one on the closing chunk), they are joined, and the count no longer matches, so the signature is dropped.
 * Here the chunks go out without theirs, and one last chunk carries the list a single reply would have had: the text part's
 * (if there is text) and each call's, in order. Found against the real service, not in a test double.
 */
export const withStreamSafety = (Base: ChatCtor): ChatCtor => class extends Base {
  override async *_streamResponseChunks(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): AsyncGenerator<ChatGenerationChunk> {
    let hasText = false;
    let textSignature = '';
    const callSignatures: string[] = [];
    for await (const chunk of super._streamResponseChunks(messages, options, runManager)) {
      const kwargs = chunk.message.additional_kwargs as { signatures?: unknown; tool_calls?: unknown[] };
      const text = typeof chunk.text === 'string' && chunk.text.length > 0;
      if (text) hasText = true;
      if (Array.isArray(kwargs.signatures)) {
        const signatures = kwargs.signatures as string[];
        const calls = kwargs.tool_calls?.length ?? 0;
        // A list that does not match this chunk's parts is not understood, and is left out rather than guessed at.
        if (signatures.length === (text ? 1 : 0) + calls) {
          if (text && signatures[0]) textSignature = signatures[0];
          callSignatures.push(...signatures.slice(text ? 1 : 0));
        }
        delete kwargs.signatures;
      }
      yield chunk;
    }
    if (callSignatures.length > 0) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({ content: '', additional_kwargs: { signatures: [...(hasText ? [textSignature] : []), ...callSignatures] } }),
      });
    }
  }
};

/** The clients for every task. `endpoint` is where requests go: Google's regional host, or the relay's. */
export function buildVertexTasks(config: ChatLlmConfig, tasks: TaskSpecs, endpoint: string, Chat: ChatCtor, Agent: ChatCtor): TaskClients {
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
    // The agent is the chat model as it is, with its thinking left to it: the graph binds the tools and reads the replies.
    if (task.name === 'agent') {
      clients.agent = new Agent({
        model: config.model,
        location: config.region,
        endpoint,
        maxOutputTokens: task.maxTokens,
        ...(gemini ? { safetySettings: SAFETY_SETTINGS } : {}),
        maxRetries: config.maxRetries,
        authOptions: { projectId: config.project },
      }) as unknown as TaskClients['agent'];
      continue;
    }
    const clientWith = (thinking: Record<string, unknown>) => new Chat({
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
