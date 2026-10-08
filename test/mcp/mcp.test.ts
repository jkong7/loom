import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { McpClient } from '../../src/mcp/client.ts';
import { McpManager } from '../../src/mcp/manager.ts';
import { ToolRegistry } from '../../src/agent/tool.ts';
import { startServer, sse } from '../helpers/http.ts';

const fixture = join(import.meta.dirname, '..', 'fixtures', 'mcp-echo.ts');

test('stdio MCP: initialize, list and call tools through the registry', async () => {
  const reg = new ToolRegistry();
  const mgr = new McpManager();
  const status = await mgr.connectAll({ echo: { command: process.execPath, args: [fixture] }, broken: { command: '/nonexistent/server' } }, reg, { timeoutMs: 5000 });
  try {
    const ok = status.find((s) => s.name === 'echo')!;
    assert.equal(ok.connected, true);
    assert.equal(ok.tools, 2);
    assert.equal(status.find((s) => s.name === 'broken')!.connected, false);
    const tool = reg.get('mcp__echo__echo')!;
    assert.equal(tool.kind, 'mcp');
    assert.equal(tool.concurrent, true);
    const r: any = await tool.execute({ text: 'hi' }, { signal: new AbortController().signal } as any);
    assert.equal(r.content[0].text, 'echo: hi');
    const f: any = await reg.get('mcp__echo__fail')!.execute({}, { signal: new AbortController().signal } as any);
    assert.equal(f.isError, true);
    assert.match(mgr.instructions(), /Use echo to repeat/);
  } finally {
    await mgr.closeAll();
  }
});

test('streamable HTTP MCP: session id, JSON and SSE responses, bearer header', async () => {
  const srv = await startServer((req, res) => {
    const m = req.body;
    if (m.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (m.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'h' } } }));
      return;
    }
    if (m.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'add', inputSchema: { type: 'object' } }] } }));
      return;
    }
    sse(res, [{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] } }]);
  });
  process.env.LOOM_TEST_TOKEN = 'tok';
  const c = new McpClient('h', { url: `${srv.url}/mcp`, headers: { authorization: 'Bearer ${LOOM_TEST_TOKEN}' } });
  try {
    await c.connect();
    const tools = await c.listTools();
    assert.equal(tools[0].name, 'add');
    const r = await c.callTool('add', { a: 2, b: 3 });
    assert.equal((r.content[0] as any).text, '5');
    const last = srv.requests.at(-1)!;
    assert.equal(last.headers['mcp-session-id'], 'sess-1');
    assert.equal(last.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(last.headers.authorization, 'Bearer tok');
  } finally {
    await c.close();
    await srv.close();
  }
});
