import { hostname, userInfo } from 'node:os';
import type { AssistantMessage, Context, Message, Model, ToolCallPart, ToolResultMessage, UserContent, AssistantContent } from '../ai/types.ts';
import { textOf } from '../ai/types.ts';
import { activeSpan, newSpanId, newTraceId, type SpanContext } from './context.ts';

export interface TelemetryConfig {
  enabled?: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName?: string;
  project?: string;
  captureContent?: boolean;
  sampleRate?: number;
  maxAttributeChars?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  timeoutMs?: number;
  resource?: Record<string, string>;
}

type AttrValue = string | number | boolean | string[];
type Attrs = Record<string, AttrValue | null | undefined>;

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startNs: bigint;
  endNs: bigint;
  attrs: Attrs;
  status: { code: number; message?: string };
  events: { name: string; timeNs: bigint; attrs: Attrs }[];
}

const VERSION = '0.1.0';
const INCLUSIVE_INPUT = /openai|azure|gemini|google|vertex/;

function nowNs(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
  } catch {
    return false;
  }
}

function parseHeaderList(v: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (v ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[decodeURIComponent(pair.slice(0, i).trim())] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

function envBool(v: string | undefined): boolean | undefined {
  if (v == null || v === '') return undefined;
  return /^(1|true|yes|on)$/i.test(v);
}

export function resolveTelemetryConfig(cfg: TelemetryConfig = {}, env: NodeJS.ProcessEnv = process.env): Required<Pick<TelemetryConfig, 'enabled' | 'endpoint' | 'serviceName' | 'captureContent' | 'sampleRate' | 'maxAttributeChars' | 'batchSize' | 'flushIntervalMs' | 'timeoutMs'>> & TelemetryConfig {
  const endpoint = (cfg.endpoint ?? env.LOOM_OTEL_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').replace(/\/$/, '');
  const disabled = envBool(env.LOOM_TELEMETRY) === false || envBool(env.OTEL_SDK_DISABLED) === true;
  const enabled = !disabled && (cfg.enabled ?? !!endpoint) && !!endpoint;
  const capture = cfg.captureContent ?? envBool(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT) ?? isLoopback(endpoint);
  const headers = { ...parseHeaderList(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseHeaderList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS), ...cfg.headers };
  const rate = cfg.sampleRate ?? (env.OTEL_TRACES_SAMPLER_ARG ? Number(env.OTEL_TRACES_SAMPLER_ARG) : 1);
  return {
    ...cfg,
    enabled,
    endpoint,
    headers,
    serviceName: cfg.serviceName ?? env.OTEL_SERVICE_NAME ?? 'loom',
    project: cfg.project ?? env.LOOM_PROJECT ?? env.BLACKBOX_PROJECT,
    captureContent: capture,
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1,
    maxAttributeChars: cfg.maxAttributeChars ?? 64000,
    batchSize: cfg.batchSize ?? 256,
    flushIntervalMs: cfg.flushIntervalMs ?? 1000,
    timeoutMs: cfg.timeoutMs ?? 5000,
  };
}

function tracesUrl(endpoint: string): string {
  return /\/v1\/traces$/.test(endpoint) ? endpoint : `${endpoint}/v1/traces`;
}

function anyValue(v: AttrValue): Record<string, unknown> {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
  return { stringValue: v };
}

function encodeAttrs(a: Attrs): { key: string; value: Record<string, unknown> }[] {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, v] of Object.entries(a)) if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) out.push({ key, value: anyValue(v) });
  return out;
}

export class OtlpExporter {
  readonly url: string;
  private queue: FinishedSpan[] = [];
  private timer?: NodeJS.Timeout;
  private inflight = new Set<Promise<void>>();
  dropped = 0;
  exported = 0;
  lastError?: string;

  private cfg: ReturnType<typeof resolveTelemetryConfig>;
  private resource: Attrs;
  private fetchImpl: typeof fetch;

  constructor(cfg: ReturnType<typeof resolveTelemetryConfig>, resource: Attrs, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.resource = resource;
    this.fetchImpl = fetchImpl;
    this.url = tracesUrl(cfg.endpoint);
  }

  push(span: FinishedSpan): void {
    if (this.queue.length >= this.cfg.batchSize * 20) {
      this.dropped++;
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.cfg.batchSize) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.cfg.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.queue.splice(0);
    if (batch.length) {
      const p = this.send(batch).finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
    return Promise.all([...this.inflight]).then(() => {});
  }

  private async send(batch: FinishedSpan[]): Promise<void> {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: encodeAttrs(this.resource) },
          scopeSpans: [
            {
              scope: { name: 'loom', version: VERSION },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? '',
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: s.startNs.toString(),
                endTimeUnixNano: s.endNs.toString(),
                attributes: encodeAttrs(s.attrs),
                events: s.events.map((e) => ({ name: e.name, timeUnixNano: e.timeNs.toString(), attributes: encodeAttrs(e.attrs) })),
                status: s.status,
              })),
            },
          ],
        },
      ],
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, { method: 'POST', headers: { 'content-type': 'application/json', ...this.cfg.headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.cfg.timeoutMs) });
        if (res.ok) {
          this.exported += batch.length;
          this.lastError = undefined;
          return;
        }
        this.lastError = `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) {
        this.lastError = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt).unref?.());
    }
    this.dropped += batch.length;
  }
}

export class Span {
  readonly context: SpanContext;
  private attrs: Attrs;
  private events: FinishedSpan['events'] = [];
  private startNs = nowNs();
  private ended = false;
  private parentId?: string;

  private tracer: Tracer;
  readonly name: string;
  private kind: number;

  constructor(tracer: Tracer, name: string, parent: SpanContext | undefined, attrs: Attrs, kind = 1) {
    this.tracer = tracer;
    this.name = name;
    this.kind = kind;
    this.context = { traceId: parent?.traceId ?? newTraceId(), spanId: newSpanId(), sampled: parent ? parent.sampled : tracer.sample() };
    this.parentId = parent?.spanId;
    this.attrs = attrs;
  }

  set(attrs: Attrs): this {
    Object.assign(this.attrs, attrs);
    return this;
  }

  event(name: string, attrs: Attrs = {}): this {
    this.events.push({ name, timeNs: nowNs(), attrs });
    return this;
  }

  end(error?: string, attrs?: Attrs): void {
    if (this.ended) return;
    this.ended = true;
    if (attrs) Object.assign(this.attrs, attrs);
    if (error) this.attrs['error.type'] = this.attrs['error.type'] ?? 'error';
    if (!this.context.sampled) return;
    this.tracer.record({
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.parentId,
      name: this.name,
      kind: this.kind,
      startNs: this.startNs,
      endNs: nowNs(),
      attrs: this.attrs,
      status: error ? { code: 2, message: error.slice(0, 1000) } : { code: 1 },
      events: this.events,
    });
  }
}

function providerName(p: string): string {
  if (p === 'google') return 'gcp.gemini';
  if (p === 'openai-chat') return 'openai';
  return p;
}

function partsOf(content: (UserContent | AssistantContent)[], max: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const c of content) {
    if (c.type === 'text') out.push({ type: 'text', content: c.text.slice(0, max) });
    else if (c.type === 'thinking') out.push({ type: 'reasoning', content: c.redacted ? '[redacted]' : c.text.slice(0, max) });
    else if (c.type === 'toolCall') out.push({ type: 'tool_call', id: c.id, name: c.name, arguments: c.args });
    else if (c.type === 'image') out.push({ type: 'blob', modality: 'image', mime_type: c.mimeType, content: '[image omitted]' });
  }
  return out;
}

export function toGenAiMessages(messages: Message[], max = 64000): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', parts: [{ type: 'tool_call_response', id: m.toolCallId, response: textOf(m.content).slice(0, max) }] };
    return { role: m.role, parts: partsOf(m.content, max) };
  });
}

function json(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export interface RunInfo {
  sessionId: string;
  prompt: string;
  model: Model;
  agentName: string;
  depth: number;
  cwd: string;
}

export class Tracer {
  readonly cfg: ReturnType<typeof resolveTelemetryConfig>;
  readonly exporter: OtlpExporter;

  constructor(cfg: TelemetryConfig = {}, opts: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}) {
    this.cfg = resolveTelemetryConfig(cfg, opts.env);
    let user = '';
    try {
      user = userInfo().username;
    } catch {}
    const resource: Attrs = {
      'service.name': this.cfg.serviceName,
      'service.version': VERSION,
      'telemetry.sdk.name': 'loom',
      'telemetry.sdk.language': 'nodejs',
      'host.name': hostname(),
      'process.pid': process.pid,
      'enduser.id': user || undefined,
      'blackbox.project': this.cfg.project,
      ...this.cfg.resource,
    };
    this.exporter = new OtlpExporter(this.cfg, resource, opts.fetch);
  }

  static fromConfig(cfg?: TelemetryConfig, opts?: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv }): Tracer | undefined {
    const t = new Tracer(cfg, opts);
    return t.cfg.enabled ? t : undefined;
  }

  sample(): boolean {
    return this.cfg.sampleRate >= 1 || Math.random() < this.cfg.sampleRate;
  }

  record(s: FinishedSpan): void {
    this.exporter.push(s);
  }

  private clip(v: unknown): string | undefined {
    if (!this.cfg.captureContent || v === undefined || v === null) return undefined;
    return json(v, this.cfg.maxAttributeChars);
  }

  startRun(info: RunInfo): Span {
    return new Span(this, `invoke_agent ${info.agentName}`, activeSpan(), {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': info.agentName,
      'gen_ai.conversation.id': info.sessionId,
      'session.id': info.sessionId,
      'gen_ai.provider.name': providerName(info.model.provider),
      'gen_ai.request.model': info.model.id,
      'loom.depth': info.depth,
      'loom.cwd': info.cwd,
      'input.value': this.clip(info.prompt),
    });
  }

  endRun(span: Span, r: { reason: string; text: string; turns: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }; error?: string }): void {
    const error = r.reason === 'error' ? r.error ?? 'error' : undefined;
    span.end(error, {
      'output.value': this.clip(r.text),
      'loom.end_reason': r.reason,
      'loom.turns': r.turns,
      'loom.usage.input_tokens': r.usage.input,
      'loom.usage.output_tokens': r.usage.output,
      'loom.usage.cache_read_tokens': r.usage.cacheRead,
      'loom.usage.cost_usd': r.usage.cost,
      'error.type': error ? 'agent_error' : r.reason === 'max_turns' || r.reason === 'refusal' || r.reason === 'blocked' ? r.reason : undefined,
    });
  }

  startLlm(parent: SpanContext | undefined, model: Model, ctx: Context, sessionId: string, opts: { maxTokens?: number; temperature?: number; reasoning?: string } = {}): Span {
    return new Span(this, `chat ${model.id}`, parent, {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': providerName(model.provider),
      'gen_ai.request.model': model.id,
      'gen_ai.request.max_tokens': opts.maxTokens,
      'gen_ai.request.temperature': opts.temperature,
      'loom.reasoning': opts.reasoning,
      'gen_ai.conversation.id': sessionId,
      'session.id': sessionId,
      'gen_ai.system_instructions': this.clip(ctx.system.map((s) => ({ type: 'text', content: s.text }))),
      'gen_ai.input.messages': this.clip(toGenAiMessages(ctx.messages, this.cfg.maxAttributeChars)),
      'gen_ai.tool.definitions': this.clip(ctx.tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))),
      'loom.tool_count': ctx.tools?.length ?? 0,
    }, 3);
  }

  endLlm(span: Span, m: AssistantMessage, firstChunkMs?: number): void {
    const inclusive = INCLUSIVE_INPUT.test(providerName(m.provider));
    span.end(m.stopReason === 'error' ? m.error ?? 'model error' : undefined, {
      'gen_ai.response.model': m.model,
      'gen_ai.response.finish_reasons': [m.stopReason],
      'gen_ai.usage.input_tokens': m.usage.input + (inclusive ? m.usage.cacheRead : 0),
      'gen_ai.usage.output_tokens': m.usage.output,
      'gen_ai.usage.cache_read.input_tokens': m.usage.cacheRead || undefined,
      'gen_ai.usage.cache_creation.input_tokens': m.usage.cacheWrite || undefined,
      'gen_ai.usage.reasoning.output_tokens': m.usage.reasoning,
      'gen_ai.usage.cost': m.usage.cost || undefined,
      'gen_ai.client.operation.time_to_first_chunk': firstChunkMs != null ? firstChunkMs / 1000 : undefined,
      'gen_ai.output.messages': this.clip([{ role: 'assistant', parts: partsOf(m.content, this.cfg.maxAttributeChars), finish_reason: m.stopReason }]),
      'error.type': m.stopReason === 'error' ? 'model_error' : undefined,
    });
  }

  startTool(parent: SpanContext | undefined, call: ToolCallPart, sessionId: string): Span {
    return new Span(this, `execute_tool ${call.name}`, parent, {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': call.name,
      'gen_ai.tool.call.id': call.id,
      'gen_ai.tool.type': call.name.startsWith('mcp__') ? 'extension' : 'function',
      'session.id': sessionId,
      'gen_ai.tool.call.arguments': this.clip(call.args),
    });
  }

  endTool(span: Span, r: ToolResultMessage): void {
    const text = textOf(r.content);
    span.end(r.isError ? text.slice(0, 500) || 'tool error' : undefined, { 'gen_ai.tool.call.result': this.clip(text), 'tool.is_error': r.isError });
  }

  startMemory(parent: SpanContext | undefined, op: 'prefetch' | 'read' | 'create', provider: string, sessionId: string, query?: string): Span {
    const opName = op === 'prefetch' ? 'search_memory' : op === 'read' ? 'read_memory' : 'create_memory';
    return new Span(this, `${opName} ${op}`, parent, {
      'gen_ai.operation.name': opName,
      'blackbox.memory.op': op,
      'gen_ai.memory.provider': provider,
      'gen_ai.tool.name': `${provider}.${op}`,
      'session.id': sessionId,
      'gen_ai.memory.query.text': this.clip(query),
    });
  }

  endMemory(span: Span, result: string | null | undefined, error?: string): void {
    span.end(error, { 'output.value': this.clip(result ?? ''), 'loom.memory.hit': !!result, 'loom.memory.chars': result?.length ?? 0 });
  }

  flush(): Promise<void> {
    return this.exporter.flush();
  }

  status(): { endpoint: string; exported: number; dropped: number; lastError?: string; captureContent: boolean } {
    return { endpoint: this.exporter.url, exported: this.exporter.exported, dropped: this.exporter.dropped, lastError: this.exporter.lastError, captureContent: this.cfg.captureContent };
  }
}
