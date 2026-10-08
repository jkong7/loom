import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../helpers/http.ts';
import { echoTool, makeAgent, tempDir } from '../helpers/agent.ts';
import { ToolRegistry } from '../../src/agent/tool.ts';
import { EngramProvider } from '../../src/memory/engram.ts';
import { MemoryManager } from '../../src/memory/manager.ts';
import { Tracer, resolveTelemetryConfig } from '../../src/telemetry/otel.ts';
import { currentTraceparent, parseTraceparent } from '../../src/telemetry/context.ts';

function spansOf(requests: { url: string; body: any }[]): any[] {
  const out: any[] = [];
  for (const r of requests) {
    if (r.url !== '/v1/traces') continue;
    for (const rs of r.body.resourceSpans) {
      const res = Object.fromEntries(rs.resource.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
      for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push({ ...s, res, attrs: Object.fromEntries(s.attributes.map((a: any) => [a.key, Object.values(a.value)[0]])) });
    }
  }
  return out;
}

test('telemetry config: off without an endpoint, env fallbacks, content capture only on loopback by default', () => {
  assert.equal(resolveTelemetryConfig({}, {}).enabled, false);
  const local = resolveTelemetryConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=abc%3D,team=core' });
  assert.equal(local.enabled, true);
  assert.equal(local.endpoint, 'http://127.0.0.1:4318');
  assert.equal(local.captureContent, true);
  assert.deepEqual(local.headers, { 'x-api-key': 'abc=', team: 'core' });
  const remote = resolveTelemetryConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com' });
  assert.equal(remote.captureContent, false);
  assert.equal(resolveTelemetryConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com', OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'true' }).captureContent, true);
  assert.equal(resolveTelemetryConfig({ endpoint: 'http://127.0.0.1:1' }, { LOOM_TELEMETRY: 'off' }).enabled, false);
  assert.equal(Tracer.fromConfig({}, { env: {} }), undefined);
});

test('agent runs export a GenAI span tree, and memory calls carry the active traceparent to engram', async () => {
  const collector = await startServer((_req, res) => void res.end('{}'));
  const seen: { path: string; traceparent?: string }[] = [];
  const engram = await startServer((req, res) => {
    seen.push({ path: req.url, traceparent: req.headers.traceparent as string | undefined });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') return void res.end('{"ok":true}');
    if (req.url === '/v1/hooks/loom/UserPromptSubmit') return void res.end(JSON.stringify({ additionalContext: '<memory-context source="engram">\n- [m1] deploys on port 8123\n</memory-context>' }));
    res.end('{}');
  });
  const home = tempDir();
  writeFileSync(join(home, 'token'), 'tok\n');
  const memory = new MemoryManager([new EngramProvider({ url: engram.url, home, cli: [] as unknown as string[], toolTransport: 'rest' })]);
  const tracer = new Tracer({ endpoint: collector.url, project: 'otel-test', flushIntervalMs: 50 }, { env: {} });
  let toolParent: string | undefined;
  const tools = new ToolRegistry().register(echoTool()).register({ name: 'probe', description: 'probe', kind: 'read', concurrent: true, parameters: { type: 'object', properties: {} }, execute: async () => ((toolParent = currentTraceparent()), 'probed') });
  const { agent } = makeAgent(
    [
      { text: 'checking', toolCalls: [{ name: 'echo', args: { text: 'hi' } }, { name: 'probe', args: {} }], usage: { input: 100, output: 20, cacheRead: 50 } },
      { text: 'port 8123', usage: { input: 150, output: 5 } },
    ],
    { tools, memory, tracer },
  );
  try {
    const r = await agent.prompt('what port?');
    assert.equal(r.text, 'port 8123');
    await agent.close('exit');
    await tracer.flush();
    const spans = spansOf(collector.requests);
    const byName = (p: RegExp) => spans.filter((s) => p.test(s.name));
    const [root] = byName(/^invoke_agent loom$/);
    assert.ok(root, 'root agent span');
    assert.equal(root.parentSpanId, '');
    assert.equal(root.attrs['gen_ai.operation.name'], 'invoke_agent');
    assert.equal(root.attrs['session.id'], agent.session.id);
    assert.equal(root.attrs['input.value'], 'what port?');
    assert.equal(root.attrs['output.value'], 'port 8123');
    assert.equal(root.attrs['loom.turns'], '2');
    assert.equal(root.res['service.name'], 'loom');
    assert.equal(root.res['blackbox.project'], 'otel-test');
    const llm = byName(/^chat /);
    assert.equal(llm.length, 2);
    assert.ok(llm.every((s) => s.parentSpanId === root.spanId && s.traceId === root.traceId && s.kind === 3));
    assert.equal(llm[0].attrs['gen_ai.usage.input_tokens'], '100');
    assert.equal(llm[0].attrs['gen_ai.usage.cache_read.input_tokens'], '50');
    assert.match(llm[0].attrs['gen_ai.input.messages'], /deploys on port 8123/);
    assert.match(llm[0].attrs['gen_ai.output.messages'], /tool_call/);
    assert.deepEqual(llm[0].attrs['gen_ai.response.finish_reasons'], { values: [{ stringValue: 'toolUse' }] });
    const tool = byName(/^execute_tool echo$/)[0];
    assert.equal(tool.parentSpanId, root.spanId);
    assert.equal(tool.attrs['gen_ai.tool.call.result'], 'echo:hi');
    const probe = byName(/^execute_tool probe$/)[0];
    assert.equal(parseTraceparent(toolParent)!.spanId, probe.spanId, 'tools run inside their own span context');
    const mem = byName(/^search_memory prefetch$/)[0];
    assert.equal(mem.parentSpanId, root.spanId);
    assert.equal(mem.attrs['blackbox.memory.op'], 'prefetch');
    assert.equal(mem.attrs['loom.memory.hit'], true);
    const recall = seen.find((s) => s.path === '/v1/hooks/loom/UserPromptSubmit')!;
    assert.equal(parseTraceparent(recall.traceparent)!.spanId, mem.spanId, 'engram recall is a child of the memory span');
    const stop = seen.find((s) => s.path === '/v1/hooks/loom/Stop')!;
    assert.equal(parseTraceparent(stop.traceparent)!.traceId, root.traceId);
  } finally {
    await collector.close();
    await engram.close();
  }
});

test('content capture off keeps prompts, messages and tool payloads out of spans', async () => {
  const collector = await startServer((_req, res) => void res.end('{}'));
  const tracer = new Tracer({ endpoint: collector.url, captureContent: false }, { env: {} });
  const { agent } = makeAgent([{ toolCalls: [{ name: 'echo', args: { text: 'secret-arg' } }] }, { text: 'secret-answer' }], { tracer });
  try {
    await agent.prompt('secret-prompt');
    await tracer.flush();
    const raw = JSON.stringify(collector.requests.map((r) => r.body));
    assert.ok(spansOf(collector.requests).length >= 3);
    assert.doesNotMatch(raw, /secret-(prompt|arg|answer)/);
  } finally {
    await collector.close();
  }
});

test('a model error marks the llm and agent spans as errors; an unreachable collector never breaks the run', async () => {
  const collector = await startServer((_req, res) => void res.end('{}'));
  const tracer = new Tracer({ endpoint: collector.url }, { env: {} });
  const { agent } = makeAgent([{ error: 'upstream 529 overloaded', stop: 'error' }], { tracer });
  try {
    const r = await agent.prompt('hello');
    assert.equal(r.reason, 'error');
    await tracer.flush();
    const spans = spansOf(collector.requests);
    const llm = spans.find((s) => s.name.startsWith('chat '));
    const root = spans.find((s) => s.name === 'invoke_agent loom');
    assert.equal(llm.status.code, 2);
    assert.equal(root.status.code, 2);
    assert.equal(root.attrs['error.type'], 'agent_error');
  } finally {
    await collector.close();
  }
  const dead = new Tracer({ endpoint: 'http://127.0.0.1:9', timeoutMs: 200 }, { env: {} });
  const { agent: a2 } = makeAgent([{ text: 'fine' }], { tracer: dead });
  const r2 = await a2.prompt('hi');
  assert.equal(r2.text, 'fine');
  await dead.flush();
  assert.ok(dead.status().dropped > 0);
});
