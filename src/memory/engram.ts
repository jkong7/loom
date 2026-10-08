import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '../ai/types.ts';
import { textOf } from '../ai/types.ts';
import type { Tool } from '../agent/tool.ts';
import { textResult } from '../agent/tool.ts';
import { parseHookOutput, type HookEvent } from '../agent/hooks.ts';
import { McpClient, type McpTool } from '../mcp/client.ts';
import type { CompressEvent, MemoryProvider, MemorySessionInfo, MemoryStatus, TurnRecord } from './provider.ts';

export interface EngramOptions {
  url?: string;
  token?: string;
  home?: string;
  harness?: string;
  cli?: string[];
  timeoutMs?: number;
  promptTimeoutMs?: number;
  tools?: boolean;
  toolTransport?: 'auto' | 'mcp-http' | 'mcp-stdio' | 'rest' | 'none';
  ingestTurns?: boolean;
  fetch?: typeof fetch;
}

type Transport = 'rest' | 'cli' | 'spool' | 'none';

const MEMORY_TOOLS = ['memory_context', 'memory_search', 'memory_get', 'memory_write', 'memory_update', 'memory_forget'];

export function engramHome(opts: EngramOptions = {}): string {
  return opts.home ?? process.env.ENGRAM_HOME ?? join(homedir(), '.engram');
}

export function findEngramCli(): string[] | null {
  if (process.env.ENGRAM_BIN) return process.env.ENGRAM_BIN.endsWith('.js') || process.env.ENGRAM_BIN.endsWith('.ts') ? [process.execPath, process.env.ENGRAM_BIN] : [process.env.ENGRAM_BIN];
  const r = spawnSync('/bin/sh', ['-c', 'command -v engram'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return [r.stdout.trim()];
  return null;
}

function runCli(cli: string[], args: string[], input: string | undefined, timeoutMs: number, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli[0], [...cli.slice(1), ...args], { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: (err as Error).message });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout!.on('data', (d) => (stdout += d));
    child.stderr!.on('data', (d) => (stderr += d));
    child.on('error', (err) => (clearTimeout(timer), resolve({ code: -1, stdout, stderr: err.message })));
    child.on('close', (code) => (clearTimeout(timer), resolve({ code: code ?? -1, stdout, stderr })));
    child.stdin!.on('error', () => {});
    child.stdin!.end(input ?? '');
  });
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const t = textOf(m.content);
      if (t) return t;
    }
  }
  return '';
}

export class EngramProvider implements MemoryProvider {
  readonly name = 'engram';
  readonly opts: Required<Pick<EngramOptions, 'url' | 'harness' | 'timeoutMs' | 'promptTimeoutMs' | 'tools' | 'toolTransport' | 'ingestTurns'>> & EngramOptions;
  private info?: MemorySessionInfo;
  private digest: string | null = null;
  private transport: Transport = 'none';
  private toolVia = 'none';
  private mcp?: McpClient;
  private mcpTools: McpTool[] = [];
  private cli: string[] | null | undefined;
  private lastError?: string;
  private restDownAt = 0;

  private get restDown(): boolean {
    return this.restDownAt > 0 && Date.now() - this.restDownAt < 30000;
  }

  private set restDown(v: boolean) {
    this.restDownAt = v ? Date.now() : 0;
  }

  constructor(opts: EngramOptions = {}) {
    this.opts = {
      url: (opts.url ?? process.env.ENGRAM_URL ?? `http://127.0.0.1:${process.env.ENGRAM_PORT ?? 7432}`).replace(/\/$/, ''),
      harness: 'loom',
      timeoutMs: 3000,
      promptTimeoutMs: 4000,
      tools: true,
      toolTransport: 'auto',
      ingestTurns: true,
      ...opts,
    };
    this.cli = opts.cli;
  }

  private token(): string | undefined {
    if (this.opts.token) return this.opts.token;
    if (process.env.ENGRAM_TOKEN) return process.env.ENGRAM_TOKEN;
    const f = join(engramHome(this.opts), 'token');
    try {
      return readFileSync(f, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private cliCmd(): string[] | null {
    if (this.cli === undefined) this.cli = findEngramCli();
    return this.cli && this.cli.length ? this.cli : null;
  }

  private async rest(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.opts.timeoutMs): Promise<any> {
    const f = this.opts.fetch ?? fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const tok = this.token();
    if (tok) headers.authorization = `Bearer ${tok}`;
    const res = await f(`${this.opts.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`engram ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    const type = res.headers.get('content-type') ?? '';
    return type.includes('json') && text ? JSON.parse(text) : text;
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await this.rest('GET', '/healthz', undefined, 800);
      this.restDown = !(r && r.ok !== false);
    } catch {
      this.restDown = true;
    }
    return !this.restDown;
  }

  async isAvailable(): Promise<boolean> {
    if (await this.healthy()) return true;
    return this.cliCmd() !== null || existsSync(engramHome(this.opts));
  }

  hookInput(event: HookEvent, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const i = this.info;
    return {
      hook_event_name: event,
      session_id: i?.sessionId,
      transcript_path: i?.transcriptPath,
      cwd: i?.cwd,
      harness: this.opts.harness,
      model: i?.model,
      agent_context: i?.agentContext,
      parent_session_id: i?.parentSessionId,
      ...extra,
    };
  }

  async hook(event: HookEvent, extra: Record<string, unknown> = {}, timeoutMs = this.opts.timeoutMs): Promise<string[]> {
    const input = this.hookInput(event, extra);
    if (!this.restDown) {
      try {
        const out = await this.rest('POST', `/v1/hooks/${encodeURIComponent(this.opts.harness)}/${event}`, input, timeoutMs);
        this.transport = 'rest';
        return parseHookOutput(event, out).additionalContext ?? [];
      } catch (err) {
        this.lastError = (err as Error).message;
        this.restDown = true;
      }
    }
    const cli = this.cliCmd();
    if (cli) {
      const r = await runCli(cli, ['hook', this.opts.harness, event], JSON.stringify(input), Math.max(timeoutMs, 8000), this.info?.cwd);
      if (r.code === 0) {
        this.transport = 'cli';
        return parseHookOutput(event, r.stdout).additionalContext ?? [];
      }
      this.lastError = `engram hook exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`;
    }
    this.spool(event, input);
    return [];
  }

  private spool(event: string, input: unknown): void {
    try {
      const dir = join(engramHome(this.opts), 'spool');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ harness: this.opts.harness, event, input, ts: new Date().toISOString() }) + '\n');
      this.transport = 'spool';
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  async initialize(info: MemorySessionInfo): Promise<void> {
    this.info = info;
    await this.healthy();
    const ctx = await this.hook('SessionStart', { source: info.source }, this.opts.promptTimeoutMs);
    this.digest = ctx.join('\n\n') || null;
    if (!this.digest && !this.restDown) {
      try {
        const q = new URLSearchParams({ cwd: info.cwd, session_id: info.sessionId, harness: this.opts.harness });
        const text = await this.rest('GET', `/v1/context?${q}`);
        if (typeof text === 'string' && text.trim()) this.digest = text.trim();
      } catch {}
    }
    if (this.opts.tools && info.agentContext !== 'subagent') await this.connectTools();
  }

  private async connectTools(): Promise<void> {
    const mode = this.opts.toolTransport;
    if (mode === 'none') return;
    if ((mode === 'auto' || mode === 'mcp-http') && !this.restDown) {
      try {
        const tok = this.token();
        const c = new McpClient('engram', { url: `${this.opts.url}/mcp`, headers: tok ? { authorization: `Bearer ${tok}` } : {}, timeoutMs: 15000 });
        await c.connect(4000);
        this.mcpTools = (await c.listTools()).filter((t) => MEMORY_TOOLS.includes(t.name));
        this.mcp = c;
        this.toolVia = 'mcp-http';
        return;
      } catch (err) {
        this.lastError = (err as Error).message;
      }
    }
    const cli = this.cliCmd();
    if ((mode === 'auto' || mode === 'mcp-stdio') && cli) {
      try {
        const c = new McpClient('engram', { command: cli[0], args: [...cli.slice(1), 'mcp'], cwd: this.info?.cwd, timeoutMs: 15000 });
        await c.connect(8000);
        this.mcpTools = (await c.listTools()).filter((t) => MEMORY_TOOLS.includes(t.name));
        this.mcp = c;
        this.toolVia = 'mcp-stdio';
        return;
      } catch (err) {
        this.lastError = (err as Error).message;
      }
    }
    if ((mode === 'auto' || mode === 'rest') && !this.restDown) this.toolVia = 'rest';
  }

  async systemPromptBlock(): Promise<string | null> {
    if (!this.digest) return null;
    const d = this.digest.trim();
    return d.startsWith('<') ? d : `<engram-memory>\n${d}\n</engram-memory>`;
  }

  async prefetch(query: string, ctx: { sessionId: string; signal: AbortSignal }): Promise<string | null> {
    const out = await this.hook('UserPromptSubmit', { prompt: query, session_id: ctx.sessionId }, this.opts.promptTimeoutMs);
    const text = out.join('\n\n').trim();
    return text || null;
  }

  async syncTurn(turn: TurnRecord): Promise<void> {
    if (this.info?.agentContext === 'subagent') return;
    await this.hook('Stop', { prompt: turn.user, last_assistant_message: turn.assistant, stop_hook_active: false });
  }

  async onPreCompress(event: CompressEvent): Promise<string | null> {
    if (this.opts.ingestTurns && !this.restDown) {
      const turns = event.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, text: textOf(m.content), ts: new Date(m.ts).toISOString() }))
        .filter((t) => t.text);
      if (turns.length) {
        try {
          await this.rest('POST', '/v1/ingest', { harness: this.opts.harness, session_id: this.info?.sessionId, cwd: this.info?.cwd, turns });
        } catch (err) {
          this.lastError = (err as Error).message;
        }
      }
    }
    await this.hook('PreCompact', { trigger: event.trigger === 'manual' ? 'manual' : 'auto', last_assistant_message: lastAssistantText(event.messages) });
    return null;
  }

  async onPostCompress(summary: string, info: MemorySessionInfo): Promise<void> {
    this.info = info;
    await this.hook('PostCompact', { trigger: 'auto', compact_summary: summary });
    const ctx = await this.hook('SessionStart', { source: 'compact' }, this.opts.promptTimeoutMs);
    if (ctx.length) this.digest = ctx.join('\n\n');
  }

  async onSessionSwitch(info: MemorySessionInfo): Promise<void> {
    this.info = info;
    const ctx = await this.hook('SessionStart', { source: info.source }, this.opts.promptTimeoutMs);
    this.digest = ctx.join('\n\n') || this.digest;
  }

  async onDelegation(event: { task: string; result: string; childSessionId: string }): Promise<void> {
    void event;
  }

  async onSessionEnd(messages: Message[], reason: string): Promise<void> {
    void messages;
    await this.hook('SessionEnd', { reason });
  }

  tools(): Tool<any>[] {
    if (this.mcp && this.mcpTools.length) {
      const client = this.mcp;
      return this.mcpTools.map((t) => ({
        name: t.name,
        description: t.description ?? t.name,
        parameters: { type: 'object', properties: {}, ...t.inputSchema },
        kind: 'memory' as const,
        concurrent: t.annotations?.readOnlyHint === true,
        target: () => ({ kind: 'memory' as const, subject: t.name }),
        execute: async (args: Record<string, unknown>, ctx) => {
          const withCwd = { ...args };
          const schemaProps = (t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
          if ('cwd' in schemaProps && withCwd.cwd === undefined) withCwd.cwd = ctx.cwd;
          const r = await client.callTool(t.name, withCwd, ctx.signal);
          return { content: r.content, isError: r.isError };
        },
      }));
    }
    if (this.toolVia === 'rest') return this.restTools();
    return [];
  }

  private restTools(): Tool<any>[] {
    const self = this;
    const search: Tool<{ query: string; source?: string; limit?: number }> = {
      name: 'memory_search',
      kind: 'memory',
      concurrent: true,
      description: 'Search the user\'s persistent engram memory (facts, preferences, decisions, procedures) or past conversations (source: "conversations" or "all").',
      parameters: { type: 'object', properties: { query: { type: 'string' }, source: { type: 'string', enum: ['memories', 'conversations', 'all'] }, limit: { type: 'integer', minimum: 1 } }, required: ['query'] },
      async execute(a, ctx) {
        const r = await self.rest('POST', '/v1/search', { query: a.query, source: a.source, limit: a.limit ?? 8, cwd: ctx.cwd });
        const mems = (r.memories ?? []).map((m: any) => `- [${m.id}] (${m.kind}) ${m.title ?? ''}: ${m.body ?? m.text ?? ''}`.trim());
        const convs = (r.conversations ?? []).map((c: any) => `- ${c.started_at ?? ''} ${c.title ?? c.session_id}: ${(c.turns ?? []).map((t: any) => `${t.role}: ${t.snippet}`).join(' / ')}`);
        return textResult([...mems, ...convs].join('\n') || 'No matches.');
      },
    };
    const write: Tool<{ text: string; kind?: string; title?: string; scope?: string; importance?: number; supersedes?: string }> = {
      name: 'memory_write',
      kind: 'memory',
      description: 'Save a durable fact, preference, decision or procedure to the user\'s engram memory. Dedupes and merges automatically; use supersedes to replace an outdated memory.',
      parameters: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['profile', 'preference', 'fact', 'decision', 'procedure', 'episode', 'reference'] }, title: { type: 'string' }, scope: { type: 'string' }, importance: { type: 'integer', minimum: 1, maximum: 10 }, supersedes: { type: 'string' } }, required: ['text'] },
      async execute(a, ctx) {
        const r = await self.rest('POST', '/v1/memories', { ...a, cwd: ctx.cwd, harness: self.opts.harness, source: { session: ctx.sessionId, cwd: ctx.cwd } });
        return textResult(r.message ?? `${r.status ?? 'ok'} ${r.id ?? ''}`.trim(), r.status === 'rejected');
      },
    };
    const get: Tool<{ id: string }> = {
      name: 'memory_get',
      kind: 'memory',
      concurrent: true,
      description: 'Get a full engram memory by id, with provenance.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(a) {
        const r = await self.rest('GET', `/v1/memories/${encodeURIComponent(a.id)}`);
        return textResult(JSON.stringify(r, null, 2));
      },
    };
    return [search, write, get];
  }

  status(): MemoryStatus {
    return { provider: 'engram', transport: `${this.transport}${this.toolVia !== 'none' ? `, tools via ${this.toolVia}` : ''}`, healthy: this.transport === 'rest' || this.transport === 'cli', detail: this.lastError };
  }

  async shutdown(): Promise<void> {
    await this.mcp?.close().catch(() => {});
    this.mcp = undefined;
  }
}
