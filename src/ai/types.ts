export type Api = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'google-generative' | 'mock';

export type JsonSchema = Record<string, unknown>;

export interface TextPart {
  type: 'text';
  text: string;
  meta?: 'memory' | 'reminder' | 'context' | 'summary';
}

export interface ImagePart {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ThinkingPart {
  type: 'thinking';
  text: string;
  signature?: string;
  redacted?: boolean;
  provider?: string;
  model?: string;
}

export interface ToolCallPart {
  type: 'toolCall';
  id: string;
  name: string;
  args: Record<string, unknown>;
  signature?: string;
}

export type UserContent = TextPart | ImagePart;
export type AssistantContent = TextPart | ThinkingPart | ToolCallPart;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  cost?: number;
}

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'refusal';

export interface UserMessage {
  role: 'user';
  content: UserContent[];
  ts: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: AssistantContent[];
  provider: string;
  model: string;
  api: Api;
  usage: Usage;
  stopReason: StopReason;
  error?: string;
  responseId?: string;
  ts: number;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: UserContent[];
  isError: boolean;
  ts: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export interface Context {
  system: SystemBlock[];
  messages: Message[];
  tools?: ToolSpec[];
}

export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StreamOptions {
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningLevel;
  cache?: boolean;
  sessionId?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  onPayload?: (payload: unknown) => void;
}

export type StreamEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; index: number }
  | { type: 'text_delta'; index: number; delta: string }
  | { type: 'text_end'; index: number; text: string }
  | { type: 'thinking_start'; index: number }
  | { type: 'thinking_delta'; index: number; delta: string }
  | { type: 'thinking_end'; index: number; text: string }
  | { type: 'toolcall_start'; index: number; id: string; name: string }
  | { type: 'toolcall_delta'; index: number; delta: string }
  | { type: 'toolcall_end'; index: number; call: ToolCallPart }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; message: AssistantMessage };

export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type ThinkingStyle = 'adaptive' | 'budget' | 'effort' | 'none';

export interface ModelCompat {
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  supportsStreamUsage?: boolean;
  supportsReasoningEffort?: boolean;
  supportsDeveloperRole?: boolean;
  thinkTags?: boolean;
  requiresToolResultName?: boolean;
  toolIdMaxLength?: number;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  api: Api;
  baseUrl: string;
  contextWindow: number;
  maxOutput: number;
  input: ('text' | 'image')[];
  tools: boolean;
  reasoning: boolean;
  thinking: ThinkingStyle;
  caching: boolean;
  cost?: ModelCost;
  headers?: Record<string, string>;
  compat?: ModelCompat;
}

export interface ProviderConfig {
  id: string;
  api: Api;
  baseUrl: string;
  apiKeyEnv?: string[];
  apiKeyOptional?: boolean;
  headers?: Record<string, string>;
  defaults?: Partial<Omit<Model, 'id' | 'provider' | 'api' | 'baseUrl'>>;
}

export type StreamFn = (model: Model, context: Context, options: StreamOptions) => AsyncIterable<StreamEvent>;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function textOf(content: readonly (UserContent | AssistantContent)[], opts: { includeMeta?: boolean } = {}): string {
  return content
    .filter((c): c is TextPart => c.type === 'text' && (opts.includeMeta || !c.meta))
    .map((c) => c.text)
    .join('\n')
    .trim();
}

export function toolCalls(message: AssistantMessage): ToolCallPart[] {
  return message.content.filter((c): c is ToolCallPart => c.type === 'toolCall');
}

export function userText(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }], ts: Date.now() };
}
