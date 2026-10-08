import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

const store = new AsyncLocalStorage<SpanContext>();

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

export function formatTraceparent(c: SpanContext): string {
  return `00-${c.traceId}-${c.spanId}-${c.sampled ? '01' : '00'}`;
}

export function parseTraceparent(v: string | null | undefined): SpanContext | null {
  const m = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i.exec(String(v ?? '').trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1].toLowerCase(), spanId: m[2].toLowerCase(), sampled: (parseInt(m[3], 16) & 1) === 1 };
}

export function activeSpan(): SpanContext | undefined {
  return store.getStore();
}

export function currentTraceparent(): string | undefined {
  const c = store.getStore();
  return c ? formatTraceparent(c) : undefined;
}

export function withSpan<T>(ctx: SpanContext | undefined, fn: () => T): T {
  return ctx ? store.run(ctx, fn) : fn();
}

export function traceHeaders(): Record<string, string> {
  const tp = currentTraceparent();
  return tp ? { traceparent: tp } : {};
}
