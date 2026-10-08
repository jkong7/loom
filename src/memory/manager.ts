import type { Message } from '../ai/types.ts';
import type { Tool } from '../agent/tool.ts';
import { fenceRecall, type CompressEvent, type MemoryProvider, type MemorySessionInfo, type MemoryStatus, type TurnRecord } from './provider.ts';

export interface MemoryManagerOptions {
  prefetchTimeoutMs?: number;
  hookTimeoutMs?: number;
  drainTimeoutMs?: number;
  recall?: boolean;
  onError?: (provider: string, phase: string, err: unknown) => void;
}

const TRIVIAL = /^(y|n|yes|no|ok|okay|k|thanks|thank you|thx|ty|cool|nice|great|sure|go|continue|next|done|lgtm|\/\S+)[.!?]*$/i;

export function isTrivialPrompt(text: string): boolean {
  const t = text.trim();
  return t.length < 3 || TRIVIAL.test(t);
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((res) => (timer = setTimeout(() => res(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class MemoryManager {
  readonly providers: MemoryProvider[] = [];
  private active: MemoryProvider[] = [];
  private writes: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private opts: Required<Omit<MemoryManagerOptions, 'onError'>> & Pick<MemoryManagerOptions, 'onError'>;
  info?: MemorySessionInfo;
  private frozenBlock: string | null = null;

  constructor(providers: MemoryProvider[] = [], opts: MemoryManagerOptions = {}) {
    this.providers.push(...providers);
    this.opts = { prefetchTimeoutMs: 4000, hookTimeoutMs: 8000, drainTimeoutMs: 8000, recall: true, ...opts };
  }

  add(p: MemoryProvider): void {
    this.providers.push(p);
  }

  get enabled(): boolean {
    return this.active.length > 0;
  }

  private fail(p: MemoryProvider, phase: string, err: unknown): void {
    this.opts.onError?.(p.name, phase, err);
  }

  async initialize(info: MemorySessionInfo): Promise<void> {
    this.info = info;
    this.active = [];
    for (const p of this.providers) {
      try {
        if (!(await withTimeout(p.isAvailable(), 3000, false))) continue;
        await withTimeout(p.initialize(info), this.opts.hookTimeoutMs, undefined);
        this.active.push(p);
      } catch (err) {
        this.fail(p, 'initialize', err);
      }
    }
    await this.refreshBlock();
  }

  async refreshBlock(): Promise<string | null> {
    const parts: string[] = [];
    for (const p of this.active) {
      if (!p.systemPromptBlock) continue;
      try {
        const b = await withTimeout(p.systemPromptBlock(), this.opts.hookTimeoutMs, null);
        if (b?.trim()) parts.push(b.trim());
      } catch (err) {
        this.fail(p, 'systemPromptBlock', err);
      }
    }
    this.frozenBlock = parts.length ? parts.join('\n\n') : null;
    return this.frozenBlock;
  }

  systemBlock(): string | null {
    return this.frozenBlock;
  }

  async prefetch(query: string, sessionId: string, signal: AbortSignal): Promise<string | null> {
    if (!this.opts.recall || isTrivialPrompt(query)) return null;
    const parts = await Promise.all(
      this.active.map(async (p) => {
        if (!p.prefetch) return null;
        try {
          const r = await withTimeout(p.prefetch(query, { sessionId, signal }), this.opts.prefetchTimeoutMs, null);
          return r?.trim() ? fenceRecall(r, p.name) : null;
        } catch (err) {
          this.fail(p, 'prefetch', err);
          return null;
        }
      }),
    );
    const out = parts.filter((x): x is string => !!x);
    return out.length ? out.join('\n\n') : null;
  }

  syncTurn(turn: TurnRecord): void {
    if (!this.active.length) return;
    this.pendingWrites++;
    this.writes = this.writes.then(async () => {
      for (const p of this.active) {
        if (!p.syncTurn) continue;
        try {
          await withTimeout(p.syncTurn(turn), this.opts.hookTimeoutMs, undefined);
        } catch (err) {
          this.fail(p, 'syncTurn', err);
        }
      }
      this.pendingWrites--;
    });
  }

  async flush(): Promise<void> {
    await withTimeout(this.writes, this.opts.drainTimeoutMs, undefined);
  }

  get backlog(): number {
    return this.pendingWrites;
  }

  async onPreCompress(event: CompressEvent): Promise<string[]> {
    await this.flush();
    const notes: string[] = [];
    for (const p of this.active) {
      if (!p.onPreCompress) continue;
      try {
        const n = await withTimeout(p.onPreCompress(event), this.opts.hookTimeoutMs, null);
        if (n?.trim()) notes.push(n.trim());
      } catch (err) {
        this.fail(p, 'onPreCompress', err);
      }
    }
    return notes;
  }

  async onPostCompress(summary: string): Promise<void> {
    if (!this.info) return;
    const info = { ...this.info, source: 'compact' as const };
    for (const p of this.active) {
      if (!p.onPostCompress) continue;
      try {
        await withTimeout(p.onPostCompress(summary, info), this.opts.hookTimeoutMs, undefined);
      } catch (err) {
        this.fail(p, 'onPostCompress', err);
      }
    }
    await this.refreshBlock();
  }

  async onSessionSwitch(info: MemorySessionInfo): Promise<void> {
    await this.flush();
    this.info = info;
    for (const p of this.active) {
      try {
        await p.onSessionSwitch?.(info);
      } catch (err) {
        this.fail(p, 'onSessionSwitch', err);
      }
    }
    await this.refreshBlock();
  }

  async onDelegation(event: { task: string; result: string; childSessionId: string }): Promise<void> {
    for (const p of this.active) {
      try {
        await p.onDelegation?.(event);
      } catch (err) {
        this.fail(p, 'onDelegation', err);
      }
    }
  }

  async onSessionEnd(messages: Message[], reason: string): Promise<void> {
    await this.flush();
    for (const p of this.active) {
      try {
        await withTimeout(p.onSessionEnd?.(messages, reason) ?? Promise.resolve(), this.opts.hookTimeoutMs, undefined);
      } catch (err) {
        this.fail(p, 'onSessionEnd', err);
      }
    }
  }

  tools(): Tool<any>[] {
    const out: Tool<any>[] = [];
    const seen = new Set<string>();
    for (const p of this.active) {
      for (const t of p.tools?.() ?? []) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        out.push(t);
      }
    }
    return out;
  }

  status(): MemoryStatus[] {
    return this.providers.map((p) => p.status?.() ?? { provider: p.name, transport: 'n/a', healthy: this.active.includes(p) });
  }

  async shutdown(): Promise<void> {
    await this.flush();
    for (const p of [...this.active].reverse()) {
      try {
        await withTimeout(p.shutdown?.() ?? Promise.resolve(), 3000, undefined);
      } catch (err) {
        this.fail(p, 'shutdown', err);
      }
    }
  }
}
