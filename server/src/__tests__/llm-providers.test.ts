import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createChatLlm, llmProviders } from 'spine-core/llm/index.js';
import type { ChatLlmConfig } from 'spine-core/llm/index.js';
import { useModelProviders } from '../providers.js';

/** The providers the relay service runs (anthropic, vertex): their settings are refused when they are not stated, and the shared package knows none of them. */
beforeAll(() => useModelProviders());

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

describe('the providers the server adds to the registry', () => {
  it('are the shared package’s relay and the two the relay service runs', () => {
    expect(llmProviders().sort()).toEqual(['anthropic', 'relay', 'vertex']);
  });

  it('names them all when a provider is unknown', () => {
    expect(() => createChatLlm({ ...base, provider: 'openai' })).toThrow(/unknown SPINE_LLM_PROVIDER "openai".*relay.*anthropic.*vertex/s);
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
