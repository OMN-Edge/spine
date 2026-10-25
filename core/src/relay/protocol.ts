import { z } from 'zod';

/**
 * What a device and the relay say to each other. Neutral on purpose: it names a task and carries messages, and the relay turns it into
 * whatever the provider behind it speaks (`llm/adapters/`), so a new provider is an adapter and not a change here or on the device.
 *
 * - `POST /v1/task/<task>`: a task from `llm/tasks.ts`. Messages are LangChain's stored form. A task with a schema answers
 *   `{ result }` (already parsed against the schema the relay's adapter bound); the agent, which is the chat model itself, takes the tools
 *   it may call and answers `{ message }`, or, when `stream` is set, one JSON line a piece (`StreamLine`).
 * - `POST /v1/embed`: texts in, one vector each out.
 * Errors are `{ error, code? }` with a status; `code: 'blocked'` means the model refused these words.
 */
export const TASK_PATH = /^\/v1\/task\/([A-Za-z]+)$/;
export const EMBED_PATH = '/v1/embed';

const stored = z.object({
  type: z.enum(['human', 'ai', 'system', 'tool']),
  data: z.object({ content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]) }).passthrough(),
});

export const taskRequest = z.object({
  model: z.string().max(200).optional(),
  messages: z.array(stored).min(1).max(500),
  // Declarations only: the relay never runs a tool, it hands them to the model, which may ask the device to.
  tools: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  stream: z.boolean().optional(),
});
export type TaskRequest = z.infer<typeof taskRequest>;

export const embedRequest = z.object({
  texts: z.array(z.string().max(100_000)).min(1).max(64),
  kind: z.enum(['document', 'query']),
});
export type EmbedRequest = z.infer<typeof embedRequest>;

/** One piece of a streamed reply, as an `AIMessageChunk` is made again from it. */
export interface StreamLine {
  chunk?: {
    content: unknown;
    tool_call_chunks?: unknown[];
    additional_kwargs?: Record<string, unknown>;
    response_metadata?: Record<string, unknown>;
    usage_metadata?: unknown;
    id?: string;
  };
  error?: string;
  code?: string;
}
