import type { Api, AssistantMessage, Context, Model, ProviderConfig, StreamEvent, StreamFn, StreamOptions } from './types.ts';
import { streamAnthropic } from './providers/anthropic.ts';
import { streamOpenAIChat } from './providers/openai-chat.ts';
import { streamOpenAIResponses } from './providers/openai-responses.ts';
import { streamGoogle } from './providers/google.ts';
import { streamMock } from './providers/mock.ts';

const apis = new Map<string, StreamFn>([
  ['anthropic-messages', streamAnthropic],
  ['openai-chat', streamOpenAIChat],
  ['openai-responses', streamOpenAIResponses],
  ['google-generative', streamGoogle],
  ['mock', streamMock],
]);

export function registerApi(api: string, fn: StreamFn): void {
  apis.set(api, fn);
}

const localCompat = { supportsStreamUsage: true, thinkTags: true, maxTokensField: 'max_tokens' as const };

const PROVIDERS: ProviderConfig[] = [
  { id: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKeyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], defaults: { contextWindow: 200000, maxOutput: 64000, input: ['text', 'image'], tools: true, reasoning: true, thinking: 'adaptive', caching: true } },
  { id: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: ['OPENAI_API_KEY'], defaults: { contextWindow: 400000, maxOutput: 128000, input: ['text', 'image'], tools: true, reasoning: true, thinking: 'effort', caching: true } },
  { id: 'openai-chat', api: 'openai-chat', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: ['OPENAI_API_KEY'], defaults: { contextWindow: 128000, maxOutput: 16384, input: ['text', 'image'], tools: true, reasoning: false, thinking: 'none', caching: true, compat: { maxTokensField: 'max_completion_tokens', supportsDeveloperRole: true, supportsReasoningEffort: true, thinkTags: false } } },
  { id: 'google', api: 'google-generative', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], defaults: { contextWindow: 1048576, maxOutput: 65536, input: ['text', 'image'], tools: true, reasoning: true, thinking: 'budget', caching: true } },
  { id: 'openrouter', api: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: ['OPENROUTER_API_KEY'], headers: { 'X-Title': 'loom' }, defaults: { contextWindow: 128000, maxOutput: 16384, input: ['text', 'image'], tools: true, reasoning: false, thinking: 'none', caching: false, compat: { thinkTags: false } } },
  { id: 'groq', api: 'openai-chat', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: ['GROQ_API_KEY'], defaults: { contextWindow: 131072, maxOutput: 8192, input: ['text'], tools: true, reasoning: false, thinking: 'none', caching: false } },
  { id: 'deepseek', api: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: ['DEEPSEEK_API_KEY'], defaults: { contextWindow: 128000, maxOutput: 8192, input: ['text'], tools: true, reasoning: false, thinking: 'none', caching: true } },
  { id: 'xai', api: 'openai-chat', baseUrl: 'https://api.x.ai/v1', apiKeyEnv: ['XAI_API_KEY'], defaults: { contextWindow: 256000, maxOutput: 16384, input: ['text', 'image'], tools: true, reasoning: false, thinking: 'none', caching: true } },
  { id: 'ollama', api: 'openai-chat', baseUrl: ollamaBase(), apiKeyEnv: ['OLLAMA_API_KEY'], apiKeyOptional: true, defaults: { contextWindow: 32768, maxOutput: 8192, input: ['text'], tools: true, reasoning: false, thinking: 'none', caching: false, compat: localCompat } },
  { id: 'lmstudio', api: 'openai-chat', baseUrl: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1', apiKeyEnv: ['LMSTUDIO_API_KEY'], apiKeyOptional: true, defaults: { contextWindow: 32768, maxOutput: 8192, input: ['text'], tools: true, reasoning: false, thinking: 'none', caching: false, compat: localCompat } },
  { id: 'vllm', api: 'openai-chat', baseUrl: process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1', apiKeyEnv: ['VLLM_API_KEY'], apiKeyOptional: true, defaults: { contextWindow: 32768, maxOutput: 8192, input: ['text'], tools: true, reasoning: false, thinking: 'none', caching: false, compat: localCompat } },
  { id: 'mock', api: 'mock', baseUrl: 'mock://', apiKeyOptional: true, defaults: { contextWindow: 200000, maxOutput: 8192, input: ['text', 'image'], tools: true, reasoning: true, thinking: 'none', caching: false } },
];

function ollamaBase(): string {
  const host = process.env.OLLAMA_HOST;
  if (!host) return 'http://127.0.0.1:11434/v1';
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return withScheme.replace(/\/$/, '') + '/v1';
}

type ModelSeed = Partial<Model> & { id: string; provider: string };

const anthropicCost = (input: number, output: number, read = input * 0.1) => ({ input, output, cacheRead: read, cacheWrite: input * 1.25 });

const MODELS: ModelSeed[] = [
  { provider: 'anthropic', id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(10, 50, 0.25) },
  { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(4, 20, 0.2) },
  { provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(5, 25) },
  { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(2, 10, 0.2) },
  { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(2, 10) },
  { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(0.1, 0.5) },
  { provider: 'anthropic', id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(5, 25) },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000, maxOutput: 128000, cost: anthropicCost(3, 15) },
  { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxOutput: 64000, thinking: 'budget', cost: anthropicCost(1, 5) },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5', contextWindow: 400000, maxOutput: 128000, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { provider: 'openai', id: 'gpt-5-mini', name: 'GPT-5 mini', contextWindow: 400000, maxOutput: 128000, cost: { input: 0.25, output: 2, cacheRead: 0.025 } },
  { provider: 'openai', id: 'gpt-5-nano', name: 'GPT-5 nano', contextWindow: 400000, maxOutput: 128000, cost: { input: 0.05, output: 0.4, cacheRead: 0.005 } },
  { provider: 'openai', id: 'gpt-5-codex', name: 'GPT-5 Codex', contextWindow: 400000, maxOutput: 128000, cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { provider: 'openai', id: 'o4-mini', name: 'o4-mini', contextWindow: 200000, maxOutput: 100000, cost: { input: 1.1, output: 4.4, cacheRead: 0.275 } },
  { provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576, maxOutput: 32768, reasoning: false, thinking: 'none', cost: { input: 2, output: 8, cacheRead: 0.5 } },
  { provider: 'openai-chat', id: 'gpt-4.1', name: 'GPT-4.1 (chat completions)', contextWindow: 1047576, maxOutput: 32768, cost: { input: 2, output: 8, cacheRead: 0.5 } },
  { provider: 'openai-chat', id: 'gpt-5', name: 'GPT-5 (chat completions)', contextWindow: 400000, maxOutput: 128000, reasoning: true, thinking: 'effort', cost: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { provider: 'google', id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', cost: { input: 1.25, output: 10, cacheRead: 0.31 } },
  { provider: 'google', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', cost: { input: 0.3, output: 2.5, cacheRead: 0.075 } },
  { provider: 'google', id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', cost: { input: 0.1, output: 0.4, cacheRead: 0.025 } },
  { provider: 'google', id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (preview)', cost: { input: 2, output: 12, cacheRead: 0.2 } },
  { provider: 'openrouter', id: 'anthropic/claude-sonnet-5-5', name: 'Claude Sonnet 5.5 via OpenRouter', contextWindow: 1000000, maxOutput: 64000, reasoning: true, caching: true },
  { provider: 'openrouter', id: 'openai/gpt-5', name: 'GPT-5 via OpenRouter', contextWindow: 400000, maxOutput: 128000, reasoning: true },
  { provider: 'openrouter', id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro via OpenRouter', contextWindow: 1048576, maxOutput: 65536, reasoning: true },
  { provider: 'openrouter', id: 'qwen/qwen3-coder', name: 'Qwen3 Coder via OpenRouter', contextWindow: 262144, maxOutput: 65536 },
  { provider: 'ollama', id: 'qwen3:8b', name: 'Qwen3 8B (Ollama)', contextWindow: 40960, maxOutput: 8192, reasoning: true, thinking: 'none' },
  { provider: 'ollama', id: 'gpt-oss:20b', name: 'gpt-oss 20B (Ollama)', contextWindow: 131072, maxOutput: 16384, reasoning: true },
  { provider: 'ollama', id: 'llama3.1:8b', name: 'Llama 3.1 8B (Ollama)', contextWindow: 131072, maxOutput: 8192 },
  { provider: 'mock', id: 'echo', name: 'Deterministic mock' },
];

export const ALIASES: Record<string, string> = {
  opus: 'anthropic/claude-opus-5-5',
  sonnet: 'anthropic/claude-sonnet-5-5',
  haiku: 'anthropic/claude-haiku-5-5',
  fable: 'anthropic/claude-fable-5-1',
  claude: 'anthropic/claude-opus-5-5',
  gpt: 'openai/gpt-5',
  'gpt-5': 'openai/gpt-5',
  codex: 'openai/gpt-5-codex',
  gemini: 'google/gemini-2.5-pro',
  flash: 'google/gemini-2.5-flash',
  qwen: 'ollama/qwen3:8b',
  mock: 'mock/echo',
};

export class ModelRegistry {
  private providers = new Map<string, ProviderConfig>();
  private models = new Map<string, Model>();
  aliases: Record<string, string> = { ...ALIASES };

  constructor() {
    for (const p of PROVIDERS) this.addProvider(p);
    for (const m of MODELS) this.addModel(m);
  }

  addProvider(p: ProviderConfig): void {
    const prev = this.providers.get(p.id);
    this.providers.set(p.id, prev ? { ...prev, ...p, defaults: { ...prev.defaults, ...p.defaults } } : p);
    if (!prev) return;
    for (const m of this.models.values()) {
      if (m.provider !== p.id) continue;
      if (p.baseUrl && m.baseUrl === prev.baseUrl) m.baseUrl = p.baseUrl;
      if (p.api && m.api === prev.api) m.api = p.api;
      if (p.headers) m.headers = { ...m.headers, ...p.headers };
    }
  }

  provider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  listProviders(): ProviderConfig[] {
    return [...this.providers.values()];
  }

  addModel(seed: ModelSeed): Model {
    const p = this.providers.get(seed.provider);
    if (!p) throw new Error(`unknown provider "${seed.provider}"`);
    const d = p.defaults ?? {};
    const prev = this.models.get(`${seed.provider}/${seed.id}`);
    const base: Model = prev ?? {
      id: seed.id,
      name: seed.id,
      provider: p.id,
      api: p.api,
      baseUrl: p.baseUrl,
      contextWindow: d.contextWindow ?? 128000,
      maxOutput: d.maxOutput ?? 8192,
      input: d.input ?? ['text'],
      tools: d.tools ?? true,
      reasoning: d.reasoning ?? false,
      thinking: d.thinking ?? 'none',
      caching: d.caching ?? false,
      headers: p.headers,
      compat: d.compat,
    };
    const model: Model = { ...base, ...seed, compat: { ...base.compat, ...seed.compat } } as Model;
    if (seed.reasoning === false && seed.thinking === undefined) model.thinking = 'none';
    this.models.set(`${model.provider}/${model.id}`, model);
    return model;
  }

  list(provider?: string): Model[] {
    return [...this.models.values()].filter((m) => !provider || m.provider === provider);
  }

  resolve(spec: string): Model {
    const s = this.aliases[spec] ?? spec;
    const exact = this.models.get(s);
    if (exact) return exact;
    const slash = s.indexOf('/');
    if (slash > 0) {
      const provider = s.slice(0, slash);
      const id = s.slice(slash + 1);
      if (this.providers.has(provider)) return this.addModel({ provider, id });
    }
    const byId = [...this.models.values()].filter((m) => m.id === s);
    if (byId.length) return byId[0];
    throw new Error(`unknown model "${spec}". Use provider/model, for example anthropic/claude-sonnet-5-5 or ollama/qwen3:8b`);
  }

  apiKey(model: Model, override?: string): string | undefined {
    if (override) return override;
    const p = this.providers.get(model.provider);
    for (const env of p?.apiKeyEnv ?? []) if (process.env[env]) return process.env[env];
    return undefined;
  }

  needsKey(model: Model): boolean {
    return !this.providers.get(model.provider)?.apiKeyOptional;
  }
}

export const defaultRegistry = new ModelRegistry();

export function stream(model: Model, context: Context, options: StreamOptions = {}, registry: ModelRegistry = defaultRegistry): AsyncIterable<StreamEvent> {
  const fn = apis.get(model.api as Api);
  if (!fn) throw new Error(`no stream implementation registered for api "${model.api}"`);
  const apiKey = registry.apiKey(model, options.apiKey);
  if (!apiKey && registry.needsKey(model)) {
    const env = registry.provider(model.provider)?.apiKeyEnv?.join(' or ') || 'an API key';
    return (async function* () {
      const { MessageBuilder } = await import('./stream.ts');
      const b = new MessageBuilder(model);
      yield b.start();
      yield b.fail(new Error(`no API key for provider "${model.provider}": set ${env}`));
    })();
  }
  return fn(model, context, { ...options, apiKey });
}

export async function complete(model: Model, context: Context, options: StreamOptions = {}, registry?: ModelRegistry): Promise<AssistantMessage> {
  let final: AssistantMessage | undefined;
  for await (const ev of stream(model, context, options, registry)) {
    if (ev.type === 'done' || ev.type === 'error') final = ev.message;
  }
  if (!final) throw new Error('stream ended without a final message');
  return final;
}
