import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
  'Notification',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookInput {
  hook_event_name: HookEvent;
  session_id: string;
  transcript_path: string;
  cwd: string;
  harness: string;
  [key: string]: unknown;
}

export interface HookResult {
  block: boolean;
  reason?: string;
  stop?: boolean;
  additionalContext: string[];
  systemMessages: string[];
  decision?: 'allow' | 'deny' | 'ask';
  updatedInput?: Record<string, unknown>;
}

export type HookHandler = (input: HookInput, signal: AbortSignal) => Promise<Partial<HookResult> | void> | Partial<HookResult> | void;

export interface CommandHookSpec {
  type: 'command' | 'http';
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  async?: boolean;
}

export interface HookMatcherConfig {
  matcher?: string;
  hooks: CommandHookSpec[];
}

export type HooksConfig = Partial<Record<HookEvent, HookMatcherConfig[]>>;

interface Registered {
  event: HookEvent;
  matcher?: string;
  name: string;
  handler: HookHandler;
  async?: boolean;
}

export function emptyResult(): HookResult {
  return { block: false, additionalContext: [], systemMessages: [] };
}

function matcherHits(matcher: string | undefined, input: HookInput): boolean {
  if (!matcher || matcher === '*') return true;
  const subject = String(input.tool_name ?? input.source ?? input.trigger ?? input.reason ?? '');
  try {
    return new RegExp(`^(?:${matcher})$`).test(subject);
  } catch {
    return matcher.split('|').includes(subject);
  }
}

export function expandValue(v: string): string {
  return v.replace(/\$\{file:([^}]+)\}|\$\{(\w+)\}|\$(\w+)/g, (_m, file, a, b) => {
    if (file) {
      try {
        return readFileSync(file.replace(/^~/, homedir()), 'utf8').trim();
      } catch {
        return '';
      }
    }
    return process.env[a || b] ?? '';
  });
}

export function parseHookOutput(event: HookEvent, out: unknown): Partial<HookResult> {
  const r: Partial<HookResult> = { additionalContext: [], systemMessages: [] };
  if (out === undefined || out === null || out === '') return r;
  if (typeof out === 'string') {
    const t = out.trim();
    if (!t) return r;
    try {
      return parseHookOutput(event, JSON.parse(t));
    } catch {
      if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PostCompact') r.additionalContext!.push(t);
      return r;
    }
  }
  if (typeof out !== 'object') return r;
  const o = out as Record<string, any>;
  if (o.continue === false) {
    r.stop = true;
    r.block = true;
    r.reason = o.stopReason || o.reason || 'stopped by hook';
  }
  if (o.decision === 'block') {
    r.block = true;
    r.reason = o.reason || 'blocked by hook';
  }
  if (o.decision === 'approve' || o.decision === 'allow') r.decision = 'allow';
  if (typeof o.systemMessage === 'string') r.systemMessages!.push(o.systemMessage);
  const h = o.hookSpecificOutput || {};
  const ctx = h.additionalContext ?? o.additionalContext ?? o.additional_context ?? o.context;
  if (typeof ctx === 'string' && ctx.trim()) r.additionalContext!.push(ctx);
  const pd = h.permissionDecision;
  if (pd === 'allow' || pd === 'deny' || pd === 'ask') {
    r.decision = pd;
    if (pd === 'deny') r.reason = h.permissionDecisionReason || 'denied by hook';
  }
  if (h.updatedInput && typeof h.updatedInput === 'object') r.updatedInput = h.updatedInput;
  return r;
}

function merge(into: HookResult, part: Partial<HookResult> | void): void {
  if (!part) return;
  if (part.block) {
    into.block = true;
    into.reason = [into.reason, part.reason].filter(Boolean).join('; ');
  }
  if (part.stop) into.stop = true;
  if (part.additionalContext) into.additionalContext.push(...part.additionalContext.filter(Boolean));
  if (part.systemMessages) into.systemMessages.push(...part.systemMessages);
  if (part.decision) {
    const rank = { deny: 3, ask: 2, allow: 1 } as const;
    if (!into.decision || rank[part.decision] > rank[into.decision]) into.decision = part.decision;
    if (part.decision === 'deny' && part.reason) into.reason = part.reason;
  }
  if (part.updatedInput) into.updatedInput = { ...into.updatedInput, ...part.updatedInput };
}

export function runCommandHook(spec: CommandHookSpec, input: HookInput, signal: AbortSignal): Promise<Partial<HookResult>> {
  const timeoutMs = (spec.timeout ?? 60) * 1000;
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', spec.command!], { cwd: input.cwd, env: { ...process.env, LOOM_HARNESS: 'loom', LOOM_SESSION_ID: input.session_id }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () => resolve({}));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (code === 2) return resolve({ block: true, reason: stderr.trim() || 'blocked by hook', decision: input.hook_event_name === 'PreToolUse' ? 'deny' : undefined });
      if (code !== 0) return resolve({});
      resolve(parseHookOutput(input.hook_event_name, stdout));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export async function runHttpHook(spec: CommandHookSpec, input: HookInput, signal: AbortSignal): Promise<Partial<HookResult>> {
  const ctl = AbortSignal.any([signal, AbortSignal.timeout((spec.timeout ?? 10) * 1000)]);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = expandValue(v);
  try {
    const res = await fetch(expandValue(spec.url!), { method: 'POST', headers, body: JSON.stringify(input), signal: ctl });
    if (!res.ok) return {};
    const text = await res.text();
    return parseHookOutput(input.hook_event_name, text);
  } catch {
    return {};
  }
}

export class HookBus {
  private handlers: Registered[] = [];
  private pending = new Set<Promise<unknown>>();
  onError?: (name: string, err: unknown) => void;

  on(event: HookEvent, handler: HookHandler, opts: { matcher?: string; name?: string; async?: boolean } = {}): () => void {
    const reg: Registered = { event, handler, matcher: opts.matcher, name: opts.name ?? handler.name ?? 'hook', async: opts.async };
    this.handlers.push(reg);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== reg);
    };
  }

  loadConfig(config: HooksConfig | undefined): void {
    for (const [event, groups] of Object.entries(config ?? {}) as [HookEvent, HookMatcherConfig[]][]) {
      if (!HOOK_EVENTS.includes(event)) continue;
      for (const g of groups ?? []) {
        for (const spec of g.hooks ?? []) {
          const name = spec.type === 'http' ? `http:${spec.url}` : `command:${spec.command}`;
          const handler: HookHandler = (input, signal) => (spec.type === 'http' ? runHttpHook(spec, input, signal) : runCommandHook(spec, input, signal));
          this.on(event, handler, { matcher: g.matcher, name, async: spec.async });
        }
      }
    }
  }

  count(event?: HookEvent): number {
    return this.handlers.filter((h) => !event || h.event === event).length;
  }

  async emit(input: HookInput, signal: AbortSignal = new AbortController().signal): Promise<HookResult> {
    const result = emptyResult();
    const matching = this.handlers.filter((h) => h.event === input.hook_event_name && matcherHits(h.matcher, input));
    const sync = matching.filter((h) => !h.async);
    for (const h of matching.filter((x) => x.async)) {
      const p = Promise.resolve()
        .then(() => h.handler(input, signal))
        .catch((err) => this.onError?.(h.name, err))
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
    const parts = await Promise.all(
      sync.map(async (h) => {
        try {
          return await h.handler(input, signal);
        } catch (err) {
          this.onError?.(h.name, err);
          return undefined;
        }
      }),
    );
    for (const p of parts) merge(result, p);
    return result;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
