import { spawn, type ChildProcess } from 'node:child_process';
import type { JsonSchema, UserContent } from '../ai/types.ts';
import { sseEvents } from '../ai/stream.ts';
import { expandValue } from '../agent/hooks.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = (McpStdioConfig | McpHttpConfig) & { disabled?: boolean; timeoutMs?: number; tools?: string[] };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; title?: string };
}

export interface McpCallResult {
  content: UserContent[];
  isError: boolean;
  structured?: unknown;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

interface Transport {
  send(msg: object): Promise<any | undefined>;
  close(): Promise<void>;
  onMessage?: (msg: any) => void;
}

class StdioTransport implements Transport {
  private child: ChildProcess;
  private buf = '';
  onMessage?: (msg: any) => void;
  stderr = '';
  exited = false;

  constructor(cfg: McpStdioConfig) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = expandValue(v);
    this.child = spawn(cfg.command, (cfg.args ?? []).map(expandValue), { cwd: cfg.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.onMessage?.(JSON.parse(line));
        } catch {}
      }
    });
    this.child.stderr!.on('data', (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    this.child.on('exit', () => {
      this.exited = true;
      this.onMessage?.({ __closed: true });
    });
    this.child.on('error', (err) => {
      this.exited = true;
      this.stderr += `\n${err.message}`;
      this.onMessage?.({ __closed: true });
    });
    this.child.stdin!.on('error', () => {});
  }

  async send(msg: object): Promise<undefined> {
    if (this.exited) throw new Error(`MCP server exited${this.stderr ? `: ${this.stderr.trim().slice(-500)}` : ''}`);
    this.child.stdin!.write(JSON.stringify(msg) + '\n');
    return undefined;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin!.end();
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        this.child.kill('SIGKILL');
        res();
      }, 1500);
      this.child.once('exit', () => (clearTimeout(t), res()));
      this.child.kill('SIGTERM');
    });
  }
}

class HttpTransport implements Transport {
  private cfg: McpHttpConfig;
  sessionId?: string;
  protocolVersion?: string;
  onMessage?: (msg: any) => void;

  constructor(cfg: McpHttpConfig) {
    this.cfg = cfg;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) h[k] = expandValue(v);
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  async send(msg: { id?: number }): Promise<any | undefined> {
    const res = await fetch(expandValue(this.cfg.url), { method: 'POST', headers: this.headers(), body: JSON.stringify(msg) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return undefined;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      let found: any;
      for await (const ev of sseEvents(res.body)) {
        if (!ev.data) continue;
        let d: any;
        try {
          d = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (msg.id !== undefined && d.id === msg.id && ('result' in d || 'error' in d)) found = d;
        else this.onMessage?.(d);
      }
      return found;
    }
    const text = await res.text();
    if (!text.trim()) return undefined;
    const d = JSON.parse(text);
    if (Array.isArray(d)) return d.find((x) => x.id === msg.id);
    return d;
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(expandValue(this.cfg.url), { method: 'DELETE', headers: this.headers() });
    } catch {}
  }
}

export function isHttpConfig(c: McpServerConfig): c is McpHttpConfig & { disabled?: boolean } {
  return typeof (c as McpHttpConfig).url === 'string';
}

export class McpClient {
  readonly name: string;
  readonly config: McpServerConfig;
  private transport?: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  connected = false;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.config = config;
  }

  private onMessage(msg: any): void {
    if (msg.__closed) {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server "${this.name}" closed the connection`));
        this.pending.delete(id);
      }
      this.connected = false;
      return;
    }
    if (msg.id !== undefined && msg.method) {
      const result = msg.method === 'ping' ? {} : msg.method === 'roots/list' ? { roots: [] } : undefined;
      const reply = result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported by loom' } };
      this.transport?.send(reply).catch(() => {});
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`MCP ${this.name}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    }
  }

  async request(method: string, params: object = {}, timeoutMs = this.config.timeoutMs ?? 60000, signal?: AbortSignal): Promise<any> {
    if (!this.transport) throw new Error(`MCP server "${this.name}" is not connected`);
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const p: Pending = { resolve, reject, timer };
      this.pending.set(id, p);
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          this.transport?.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'aborted' } }).catch(() => {});
          reject(new Error('aborted'));
        },
        { once: true },
      );
      this.transport!.send(msg).then(
        (direct) => {
          if (direct !== undefined) this.onMessage(direct);
        },
        (err) => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async notify(method: string, params: object = {}): Promise<void> {
    await this.transport?.send({ jsonrpc: '2.0', method, params });
  }

  async connect(timeoutMs = 20000): Promise<void> {
    const t: Transport = isHttpConfig(this.config) ? new HttpTransport(this.config) : new StdioTransport(this.config as McpStdioConfig);
    t.onMessage = (m) => this.onMessage(m);
    this.transport = t;
    const init = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'loom', version: '0.1.0' } }, timeoutMs);
    if (t instanceof HttpTransport) t.protocolVersion = init?.protocolVersion ?? MCP_PROTOCOL_VERSION;
    this.serverInfo = init?.serverInfo;
    this.instructions = init?.instructions;
    await this.notify('notifications/initialized');
    this.connected = true;
  }

  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      out.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const r = await this.request('tools/call', { name, arguments: args }, this.config.timeoutMs ?? 120000, signal);
    return { content: mapContent(r?.content ?? []), isError: !!r?.isError, structured: r?.structuredContent };
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.transport?.close();
  }
}

export function mapContent(items: any[]): UserContent[] {
  const out: UserContent[] = [];
  for (const c of items) {
    if (c.type === 'text') out.push({ type: 'text', text: c.text ?? '' });
    else if (c.type === 'image' && c.data) out.push({ type: 'image', data: c.data, mimeType: c.mimeType ?? 'image/png' });
    else if (c.type === 'resource') out.push({ type: 'text', text: c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]` });
    else if (c.type === 'resource_link') out.push({ type: 'text', text: `[resource ${c.name ?? ''} ${c.uri ?? ''}]` });
    else if (c.type === 'audio') out.push({ type: 'text', text: '[audio content omitted]' });
    else out.push({ type: 'text', text: JSON.stringify(c) });
  }
  return out;
}
