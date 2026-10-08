import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers/agent.ts';
import { Runtime } from '../src/runtime.ts';
import { LoomServer, PermissionBroker } from '../src/server/http.ts';
import { runRpc } from '../src/server/rpc.ts';
import { ModelRegistry, MockScript, setMockScript, type Context } from '../src/ai/index.ts';
import { sseEvents } from '../src/ai/stream.ts';

async function setup(steps: any[], fallback?: any) {
  const cwd = tempDir('loom-srv-');
  mkdirSync(join(cwd, '.git'));
  const id = `srv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  setMockScript(id, new MockScript(steps, fallback));
  const registry = new ModelRegistry();
  registry.addModel({ provider: 'mock', id });
  const broker = new PermissionBroker(5000);
  const rt = await Runtime.create({ cwd, home: tempDir('loom-home-'), registry, model: `mock/${id}`, memory: false, asker: broker.asker });
  return { cwd, rt, broker };
}

test('HTTP server: create a session, stream a prompt over SSE, approve a permission remotely', async () => {
  const { cwd, rt, broker } = await setup([
    { toolCalls: [{ name: 'write', args: { path: 'out.txt', content: 'written remotely' } }] },
    (ctx: Context) => ({ text: `tool said: ${(ctx.messages.at(-1) as any).content[0].text}` }),
  ]);
  const server = new LoomServer(rt, broker, { port: 0 });
  const { url } = await server.listen();
  try {
    const created = await fetch(`${url}/sessions`, { method: 'POST', body: '{}' }).then((r) => r.json());
    assert.ok(created.id);
    const res = await fetch(`${url}/sessions/${created.id}/prompt`, { method: 'POST', body: JSON.stringify({ text: 'write the file' }) });
    const events: any[] = [];
    for await (const ev of sseEvents(res.body!)) {
      const data = JSON.parse(ev.data);
      events.push({ event: ev.event, data });
      if (ev.event === 'permission_request') {
        assert.equal(data.tool, 'write');
        const ok = await fetch(`${url}/permissions/${data.id}`, { method: 'POST', body: JSON.stringify({ answer: 'allow' }) });
        assert.equal(ok.status, 200);
      }
    }
    const result = events.find((e) => e.event === 'result')!.data;
    assert.equal(result.reason, 'done');
    assert.match(result.text, /Created out\.txt/);
    assert.equal(readFileSync(join(cwd, 'out.txt'), 'utf8'), 'written remotely');
    assert.ok(events.some((e) => e.event === 'text_delta'));
    assert.ok(events.some((e) => e.event === 'tool_use'));
    const got = await fetch(`${url}/sessions/${created.id}`).then((r) => r.json());
    assert.equal(got.messages.length, 4);
    const list = await fetch(`${url}/sessions`).then((r) => r.json());
    assert.equal(list.sessions.length, 1);
  } finally {
    await server.close();
  }
});

test('HTTP server: non-streaming prompt, busy detection and denial without a client', async () => {
  const { cwd, rt, broker } = await setup([{ toolCalls: [{ name: 'write', args: { path: 'nope.txt', content: 'x' } }] }, (ctx: Context) => ({ text: (ctx.messages.at(-1) as any).content[0].text })]);
  const server = new LoomServer(rt, broker, { port: 0 });
  const { url } = await server.listen();
  try {
    const { id } = await fetch(`${url}/sessions`, { method: 'POST', body: '{}' }).then((r) => r.json());
    const r = await fetch(`${url}/sessions/${id}/prompt`, { method: 'POST', body: JSON.stringify({ text: 'go', stream: false }) }).then((r) => r.json());
    assert.match(r.text, /Permission denied/);
    assert.equal(existsSync(join(cwd, 'nope.txt')), false);
  } finally {
    await server.close();
  }
});

test('RPC mode: JSON lines in, events and responses out', async () => {
  const { rt, broker } = await setup([{ text: 'first' }, { text: 'second' }]);
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  let buf = '';
  output.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const agent = await rt.createAgent({ agentContext: 'headless' });
  const done = runRpc(rt, broker, agent, input, output);
  input.write(JSON.stringify({ id: 1, type: 'prompt', text: 'hi' }) + '\n');
  await new Promise((r) => setTimeout(r, 100));
  input.write(JSON.stringify({ id: 2, type: 'prompt', text: 'again' }) + '\n');
  await new Promise((r) => setTimeout(r, 100));
  input.write(JSON.stringify({ id: 3, type: 'get_messages' }) + '\n');
  await new Promise((r) => setTimeout(r, 50));
  input.end();
  await done;
  assert.ok(lines.some((l) => l.type === 'ready'));
  const responses = lines.filter((l) => l.type === 'response');
  assert.deepEqual(responses.map((r) => [r.id, r.text ?? r.messages?.length]), [[1, 'first'], [2, 'second'], [3, 4]]);
  assert.ok(lines.some((l) => l.type === 'event' && l.event.type === 'message_update'));
});
