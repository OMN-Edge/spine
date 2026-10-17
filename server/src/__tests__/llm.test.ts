import { describe, it, expect, afterEach } from 'vitest';
import { createChatLlm, LLM_PROVIDERS, LlmConfigError } from '../llm/index.js';
import { loadConfig } from '../config.js';
import type { ChatLlmConfig } from '../llm/index.js';

const base: ChatLlmConfig = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  maxTokens: { continuation: 256, extraction: 2048, page: 4096 },
  maxRetries: 2, contextChars: 300_000,
  logger: { info: () => {}, warn: () => {} },
};

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('createChatLlm — the adapter registry', () => {
  it('names the valid set when the provider is unknown', () => {
    expect(() => createChatLlm({ ...base, provider: 'openai' })).toThrow(
      /unknown SPINE_LLM_PROVIDER "openai".*anthropic.*vertex/s,
    );
  });

  it('throws LlmConfigError rather than returning something broken', () => {
    expect(() => createChatLlm({ ...base, provider: '' })).toThrow(LlmConfigError);
  });

  it('exposes exactly the providers that have adapters', () => {
    expect(LLM_PROVIDERS.sort()).toEqual(['anthropic', 'vertex']);
  });

  it('builds the anthropic adapter', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const llm = createChatLlm({ ...base, endpoint: 'api.anthropic.com' });
    expect(typeof llm.detectContinuation).toBe('function');
    expect(typeof llm.extractFields).toBe('function');
  });

  it('refuses the anthropic adapter with no API key', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createChatLlm(base)).toThrow(/requires ANTHROPIC_API_KEY/);
  });
});

/**
 * M-8. Residency is a property of the endpoint, so none of this may be
 * defaulted, inferred or silently reconciled.
 */
describe('vertex adapter — residency (P8, M-8)', () => {
  const vertex: ChatLlmConfig = {
    ...base,
    provider: 'vertex',
    model: 'gemini-3.8-flash',
    endpoint: 'aiplatform.eu.rep.googleapis.com',
    region: 'eu',
    project: 'demo-project',
  };

  it('requires an explicit endpoint — there is no default', () => {
    expect(() => createChatLlm({ ...vertex, endpoint: undefined })).toThrow(
      /requires SPINE_LLM_ENDPOINT/,
    );
  });

  it('requires a project', () => {
    expect(() => createChatLlm({ ...vertex, project: undefined })).toThrow(
      /requires SPINE_LLM_PROJECT/,
    );
  });

  it('requires a region, rather than parsing one out of the endpoint', () => {
    expect(() => createChatLlm({ ...vertex, region: undefined })).toThrow(
      /requires SPINE_LLM_REGION/,
    );
  });

  it.each(['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'])(
    'refuses to start when %s is merely present',
    (name) => {
      process.env[name] = 'AIza-whatever';
      // Presence, not use: with a key set, the library ignores the configured
      // endpoint and region and calls the global one.
      expect(() => createChatLlm(vertex)).toThrow(
        new RegExp(`${name}.*ignore the configured endpoint`, 's'),
      );
    },
  );

  it('an empty API key variable is not treated as present', () => {
    process.env.GOOGLE_API_KEY = '';
    expect(createChatLlm(vertex)).toBeDefined();
  });

  it('constructs when endpoint, region and project are all stated', () => {
    const llm = createChatLlm(vertex);
    expect(typeof llm.extractFields).toBe('function');
  });
});

describe('loadConfig — llm section', () => {
  const valid = { SESSION_SECRET: 'a'.repeat(32) };

  it('defaults to the provider and model that were hardcoded before the interface', () => {
    const { llm } = loadConfig({ ...valid });
    expect(llm.provider).toBe('anthropic');
    expect(llm.model).toBe('claude-haiku-4-5-20251001');
    // Extraction has room to list a lab panel's every value.
    expect(llm.maxTokens).toEqual({ continuation: 1024, extraction: 16384, page: 16384 });
  });

  it('has one cap on request text, the context window, and takes it from the environment', () => {
    expect(loadConfig({ ...valid }).llm.contextChars).toBe(300_000);
    expect(loadConfig({ ...valid, SPINE_LLM_CONTEXT_CHARS: '120000' }).llm.contextChars).toBe(120_000);
  });

  it.each(['abc', '0', '-5', '5000'])('refuses a context budget of %s', value => {
    expect(() => loadConfig({ ...valid, SPINE_LLM_CONTEXT_CHARS: value })).toThrow(/SPINE_LLM_CONTEXT_CHARS/);
  });

  it('defaults to four model calls at once, and refuses a nonsense number', () => {
    expect(loadConfig({ ...valid }).parser.concurrency).toBe(4);
    expect(loadConfig({ ...valid, SPINE_LLM_CONCURRENCY: '8' }).parser.concurrency).toBe(8);
    for (const bad of ['0', '17', 'many', '-1']) {
      expect(() => loadConfig({ ...valid, SPINE_LLM_CONCURRENCY: bad }), bad).toThrow(/SPINE_LLM_CONCURRENCY/);
    }
  });

  it('defaults the endpoint only where it carries no residency meaning', () => {
    // Anthropic has one global API, so a default is honest there.
    expect(loadConfig({ ...valid }).llm.endpoint).toBe('api.anthropic.com');
    // Vertex has regional endpoints, so there is nothing safe to default to.
    expect(loadConfig({ ...valid, SPINE_LLM_PROVIDER: 'vertex' }).llm.endpoint).toBeUndefined();
  });

  it('takes provider, model, endpoint and project from the environment', () => {
    const { llm } = loadConfig({
      ...valid,
      SPINE_LLM_PROVIDER: 'vertex',
      SPINE_LLM_MODEL: 'gemini-3.8-flash',
      SPINE_LLM_ENDPOINT: 'aiplatform.eu.rep.googleapis.com',
      SPINE_LLM_REGION: 'eu',
      SPINE_LLM_PROJECT: 'demo',
    });
    expect(llm).toMatchObject({
      provider: 'vertex',
      model: 'gemini-3.8-flash',
      endpoint: 'aiplatform.eu.rep.googleapis.com',
      region: 'eu',
      project: 'demo',
    });
  });

  it('rejects a non-numeric token budget', () => {
    expect(() => loadConfig({ ...valid, SPINE_LLM_MAX_TOKENS_EXTRACTION: 'lots' })).toThrow(
      /SPINE_LLM_MAX_TOKENS_EXTRACTION/,
    );
  });

  it('rejects a blank model', () => {
    expect(() => loadConfig({ ...valid, SPINE_LLM_MODEL: '   ' })).toThrow(/SPINE_LLM_MODEL is empty/);
  });

  it('rejects a zero retry count', () => {
    expect(() => loadConfig({ ...valid, SPINE_LLM_MAX_RETRIES: '0' })).toThrow(
      /SPINE_LLM_MAX_RETRIES/,
    );
  });

  it('reads the llm section without validating the session secrets', async () => {
    const { loadLlmConfig } = await import('../config.js');
    // No SESSION_SECRET: not this function's concern.
    const llm = loadLlmConfig({ SPINE_LLM_MODEL: 'gemini-3.8-flash' });
    expect(llm.model).toBe('gemini-3.8-flash');
  });
});

/**
 * The two tasks are fully specified at startup — output budget and schema — so
 * the adapter builds a client for each and `invoke` carries only a prompt.
 */
describe('task specs', () => {
  it('takes each task’s token budget from config', async () => {
    const { buildTaskSpecs } = await import('../llm/tasks.js');
    const specs = buildTaskSpecs({ ...base, maxTokens: { continuation: 111, extraction: 222, page: 333 } });
    expect(specs.continuation.maxTokens).toBe(111);
    expect(specs.extraction.maxTokens).toBe(222);
    // The simple tasks are told not to deliberate; extraction is left to the model.
    expect(Object.fromEntries(Object.values(specs).map(s => [s.name, s.reasoning]))).toEqual({
      continuation: 'none', extraction: 'default', page: 'none', stamps: 'none', translation: 'none',
    });
  });

  it('derives each JSON Schema from the zod schema the interface validates with', async () => {
    const { buildTaskSpecs, TASK_SCHEMAS, LLM_TASKS } = await import('../llm/tasks.js');
    const specs = buildTaskSpecs(base);

    for (const task of LLM_TASKS) {
      expect(Object.keys(TASK_SCHEMAS)).toContain(task);
      // Same source, so the provider constraint and the validation cannot drift.
      expect(specs[task].jsonSchema).toHaveProperty('properties');
    }
    expect(Object.keys(specs.continuation.jsonSchema.properties as object).sort()).toEqual(
      ['confidence', 'is_continuation', 'reasoning'],
    );
    expect(Object.keys(specs.extraction.jsonSchema.properties as object)).toContain('doc_type');
  });
});
