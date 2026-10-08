import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Agent, AgentEvent } from '../agent/agent.ts';
import type { Runtime } from '../runtime.ts';
import type { PermissionAnswer, PermissionRequest } from '../agent/permissions.ts';
import { toStreamJson } from '../cli/render.ts';

export class PermissionBroker {
  private pending = new Map<string, { resolve: (a: PermissionAnswer) => void; timer: NodeJS.Timeout; req: PermissionRequest }>();
  private listeners = new Set<(id: string, req: PermissionRequest) => void>();
  timeoutMs: number;

  constructor(timeoutMs = 300000) {
    this.timeoutMs = timeoutMs;
  }

  onRequest(fn: (id: string, req: PermissionRequest) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  asker = (req: PermissionRequest): Promise<PermissionAnswer> => {
    if (!this.listeners.size) return Promise.resolve('deny');
    const id = randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve('deny');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer, req });
      for (const l of this.listeners) l(id, req);
    });
  };

  answer(id: string, answer: PermissionAnswer): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(answer);
    return true;
  }

  list(): { id: string; tool: string; reason: string; target: unknown }[] {
    return [...this.pending.entries()].map(([id, p]) => ({ id, tool: p.req.tool, reason: p.req.reason, target: p.req.target }));
  }
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sseStart(res: ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': loom\n\n');
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export interface ServeOptions {
  port?: number;
  host?: string;
  token?: string;
}

export class LoomServer {
  readonly rt: Runtime;
  readonly broker: PermissionBroker;
  readonly agents = new Map<string, Agent>();
  private server?: Server;
  private opts: ServeOptions;

  constructor(rt: Runtime, broker: PermissionBroker, opts: ServeOptions = {}) {
    this.rt = rt;
    this.broker = broker;
    this.opts = opts;
  }

  private async agentFor(id: string): Promise<Agent | undefined> {
    const live = this.agents.get(id);
    if (live) return live;
    const s = this.rt.sessions.find(id);
    if (!s) return undefined;
    const a = await this.rt.createAgent({ session: s, agentContext: 'headless' });
    this.agents.set(s.id, a);
    return a;
  }

  handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (url.pathname === '/health') return send(res, 200, { ok: true, cwd: this.rt.cwd, sessions: this.agents.size });
      if (this.opts.token && req.headers.authorization !== `Bearer ${this.opts.token}`) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/models') return send(res, 200, { models: this.rt.registry.list().map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning, tools: m.tools })) });
      if (url.pathname === '/permissions' && req.method === 'GET') return send(res, 200, { pending: this.broker.list() });
      if (parts[0] === 'permissions' && parts[1] && req.method === 'POST') {
        const b = await body(req);
        return send(res, this.broker.answer(parts[1], b.answer ?? 'deny') ? 200 : 404, { ok: true });
      }
      if (url.pathname === '/sessions' && req.method === 'GET') return send(res, 200, { sessions: this.rt.sessions.list(url.searchParams.get('cwd') ?? this.rt.cwd, Number(url.searchParams.get('limit') ?? 50)) });
      if (url.pathname === '/sessions' && req.method === 'POST') {
        const b = await body(req);
        const a = await this.rt.createAgent({ model: b.model, resume: b.resume, fork: b.fork ? { session: b.fork, entryId: b.entryId } : undefined, reasoning: b.reasoning, agentContext: 'headless' });
        await a.start();
        this.agents.set(a.session.id, a);
        return send(res, 200, { id: a.session.id, model: `${a.model.provider}/${a.model.id}`, path: a.session.path });
      }
      if (parts[0] !== 'sessions' || !parts[1]) return send(res, 404, { error: 'not found' });
      const agent = await this.agentFor(parts[1]);
      if (!agent) return send(res, 404, { error: 'no such session' });
      const action = parts[2];
      if (!action && req.method === 'GET') return send(res, 200, { header: agent.session.header, messages: agent.session.messages(), context_tokens: agent.contextTokens() });
      if (!action && req.method === 'DELETE') {
        await agent.close('server-delete');
        this.agents.delete(agent.session.id);
        return send(res, 200, { ok: true });
      }
      if (action === 'abort') {
        agent.abort();
        return send(res, 200, { ok: true });
      }
      if (action === 'steer') {
        agent.steer(String((await body(req)).text ?? ''));
        return send(res, 200, { ok: true });
      }
      if (action === 'undo' && req.method === 'POST' && agent.isRunning) return send(res, 409, { error: 'session is busy' });
      if (action === 'undo' && req.method === 'POST') return send(res, 200, (await agent.undo()) ?? { nothing: true });
      if (action === 'compact') {
        if (agent.isRunning) return send(res, 409, { error: 'session is busy; compaction runs automatically between turns' });
        const b = await body(req);
        return send(res, 200, await agent.compact({ reason: 'manual', instructions: b.instructions }));
      }
      if (action === 'events') {
        const emit = sseStart(res);
        const off = agent.subscribe((e) => emit(e.type, e));
        const offPerm = this.broker.onRequest((id, r) => emit('permission_request', { id, tool: r.tool, reason: r.reason, target: r.target, args: r.args }));
        req.on('close', () => (off(), offPerm()));
        return;
      }
      if (action === 'prompt' && req.method === 'POST') {
        const b = await body(req);
        const text = String(b.text ?? b.prompt ?? '');
        if (agent.isRunning) return send(res, 409, { error: 'session is busy; POST /steer or /abort' });
        if (b.stream === false) {
          const r = await agent.prompt(text);
          return send(res, 200, { reason: r.reason, text: r.text, usage: r.usage, turns: r.turns, error: r.error });
        }
        const emit = sseStart(res);
        const off = agent.subscribe((e: AgentEvent) => {
          const j = toStreamJson(e, agent.session.id);
          if (j) emit(String(j.type), j);
        });
        const offPerm = this.broker.onRequest((id, r) => emit('permission_request', { id, tool: r.tool, reason: r.reason, target: r.target, args: r.args }));
        req.on('close', () => {
          if (!res.writableEnded && agent.isRunning && b.abortOnDisconnect !== false) agent.abort();
        });
        try {
          const r = await agent.prompt(text);
          emit('result', { type: 'result', session_id: agent.session.id, reason: r.reason, text: r.text, usage: r.usage, turns: r.turns, error: r.error });
        } finally {
          off();
          offPerm();
          res.end();
        }
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
      else res.end();
    }
  };

  async listen(): Promise<{ url: string; port: number }> {
    this.server = createServer(this.handler);
    await new Promise<void>((r) => this.server!.listen(this.opts.port ?? 7433, this.opts.host ?? '127.0.0.1', r));
    const port = (this.server.address() as AddressInfo).port;
    return { url: `http://${this.opts.host ?? '127.0.0.1'}:${port}`, port };
  }

  async close(): Promise<void> {
    for (const a of this.agents.values()) await a.close('server-stop').catch(() => {});
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.rt.close();
  }
}
