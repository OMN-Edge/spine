import { ChatAnthropic } from '@langchain/anthropic';
import type { TaskClients, TaskSpecs } from '../tasks.js';
import { LlmConfigError, type ChatLlmConfig } from '../types.js';

/**
 * Anthropic's direct API. No EU-only processing commitment, so this adapter is
 * not available to a deployment with a residency requirement — a configuration
 * choice, not something this file enforces.
 */
export function createAnthropicChat(
  config: ChatLlmConfig,
  tasks: TaskSpecs,
): TaskClients {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new LlmConfigError('SPINE_LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }

  // One client per task, built here: the token cap is a constructor option
  // (`maxTokens`) and the schema is fixed, so there is nothing left to decide
  // per call.
  const clients = {} as TaskClients;
  for (const task of Object.values(tasks)) {
    const model = new ChatAnthropic({
      model: config.model,
      maxTokens: task.maxTokens,
      maxRetries: config.maxRetries,
      anthropicApiUrl: `https://${config.endpoint}`,
    });
    clients[task.name] = model.withStructuredOutput(task.jsonSchema, { name: task.name });
  }

  return clients;
}
