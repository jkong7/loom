import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}

export type Handler = (req: Captured, res: ServerResponse) => void | Promise<void>;

export async function startServer(handler: Handler): Promise<{ url: string; requests: Captured[]; close: () => Promise<void> }> {
  const requests: Captured[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {}
    const cap = { method: req.method || 'GET', url: req.url || '/', headers: req.headers, body };
    requests.push(cap);
    try {
      await handler(cap, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function sse(res: ServerResponse, events: (object | string)[], opts: { named?: boolean } = {}): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) {
    if (typeof e === 'string') {
      res.write(`data: ${e}\n\n`);
      continue;
    }
    const type = (e as { type?: string }).type;
    if (opts.named && type) res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  res.end();
}
