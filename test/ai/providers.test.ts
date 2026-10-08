import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, sse } from '../helpers/http.ts';
import { ModelRegistry, stream, complete, type Context, type Message, type StreamEvent, type AssistantMessage } from '../../src/ai/index.ts';

const reg = new ModelRegistry();

function ctx(messages: Message[]): Context {
  return {
    system: [{ text: 'You are a test.', cache: true }],
    messages,
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  };
}

const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], ts: 1 });

async function collect(it: AsyncIterable<StreamEvent>): Promise<{ events: StreamEvent[]; final: AssistantMessage }> {
  const events: StreamEvent[] = [];
  for await (const e of it) events.push(e);
  const last = events[events.length - 1];
  assert.ok(last.type === 'done' || last.type === 'error');
  return { events, final: (last as { message: AssistantMessage }).message };
}

test('anthropic: thinking, text and tool_use stream into one normalized message', async () => {
  const srv = await startServer((_req, res) =>
    sse(res, [
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me read.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'now.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pa' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'th":"a.txt"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
      { type: 'message_stop' },
    ], { named: true }),
  );
  try {
    reg.addProvider({ id: 'anthropic', api: 'anthropic-messages', baseUrl: srv.url, apiKeyEnv: ['ANTHROPIC_API_KEY'] });
    const model = reg.addModel({ provider: 'anthropic', id: 'claude-opus-5-5', baseUrl: srv.url });
    const { events, final } = await collect(stream(model, ctx([user('read a.txt')]), { apiKey: 'k', reasoning: 'high' }, reg));
    assert.equal(final.stopReason, 'toolUse', final.error);
    assert.deepEqual(final.content.map((c) => c.type), ['thinking', 'text', 'toolCall']);
    assert.equal((final.content[0] as any).signature, 'SIG');
    assert.equal((final.content[1] as any).text, 'Reading now.');
    assert.deepEqual((final.content[2] as any).args, { path: 'a.txt' });
    assert.deepEqual(final.usage, { input: 10, output: 42, cacheRead: 90, cacheWrite: 0, cost: final.usage.cost });
    assert.ok(events.some((e) => e.type === 'toolcall_delta'));
    const body = srv.requests[0].body;
    assert.equal(srv.requests[0].headers['x-api-key'], 'k');
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.tools[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.messages[0].content.at(-1).cache_control, { type: 'ephemeral' });

    const follow: Message[] = [user('read a.txt'), final, { role: 'tool', toolCallId: 'toolu_1', toolName: 'read', content: [{ type: 'text', text: 'hello' }], isError: false, ts: 2 }];
    await collect(stream(model, ctx(follow), { apiKey: 'k' }, reg));
    const b2 = srv.requests[1].body;
    assert.equal(b2.messages[1].content[0].type, 'thinking');
    assert.equal(b2.messages[1].content[0].signature, 'SIG');
    assert.equal(b2.messages[2].content[0].type, 'tool_result');
    assert.equal(b2.messages[2].content[0].tool_use_id, 'toolu_1');
  } finally {
    await srv.close();
  }
});

test('openai chat: split tool call deltas, think tags and usage', async () => {
  const chunk = (delta: object, finish: string | null = null) => ({ id: 'c1', choices: [{ index: 0, delta, finish_reason: finish }] });
  const srv = await startServer((_req, res) =>
    sse(res, [
      chunk({ role: 'assistant', content: '<thi' }),
      chunk({ content: 'nk>hmm, a file</think>Sure' }),
      chunk({ content: ', reading.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"b.txt"}' } }] }),
      chunk({}, 'tool_calls'),
      { id: 'c1', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } },
      '[DONE]',
    ]),
  );
  try {
    const r = new ModelRegistry();
    r.addProvider({ id: 'ollama', api: 'openai-chat', baseUrl: srv.url + '/v1', apiKeyOptional: true });
    const model = r.resolve('ollama/qwen3:8b');
    const final = await complete(model, ctx([user('hi')]), { maxTokens: 500 }, r);
    assert.equal(final.stopReason, 'toolUse', final.error);
    assert.deepEqual(final.content.map((c) => c.type), ['thinking', 'text', 'toolCall']);
    assert.equal((final.content[0] as any).text, 'hmm, a file');
    assert.equal((final.content[1] as any).text, 'Sure, reading.');
    assert.deepEqual((final.content[2] as any).args, { path: 'b.txt' });
    assert.equal(final.usage.input, 40);
    assert.equal(final.usage.cacheRead, 60);
    const body = srv.requests[0].body;
    assert.equal(srv.requests[0].url, '/v1/chat/completions');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.max_tokens, 500);
    assert.equal(body.tools[0].function.name, 'read');
    assert.equal(srv.requests[0].headers.authorization, undefined);
  } finally {
    await srv.close();
  }
});

test('openai chat: reasoning field and tool result replay', async () => {
  const srv = await startServer((_req, res) =>
    sse(res, [
      { choices: [{ delta: { reasoning: 'thinking...' } }] },
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]),
  );
  try {
    const r = new ModelRegistry();
    r.addProvider({ id: 'vllm', api: 'openai-chat', baseUrl: srv.url, apiKeyOptional: true });
    const model = r.resolve('vllm/some-model');
    const history: Message[] = [
      user('x'),
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c|1', name: 'read', args: { path: 'a' } }], provider: 'anthropic', model: 'm', api: 'anthropic-messages', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'toolUse', ts: 1 },
      { role: 'tool', toolCallId: 'c|1', toolName: 'read', content: [{ type: 'text', text: 'body' }], isError: false, ts: 2 },
    ];
    const final = await complete(model, ctx(history), {}, r);
    assert.equal((final.content[0] as any).text, 'thinking...');
    assert.equal((final.content[1] as any).text, 'done');
    const msgs = srv.requests[0].body.messages;
    assert.equal(msgs[2].tool_calls[0].id, 'c_1');
    assert.equal(msgs[3].role, 'tool');
    assert.equal(msgs[3].tool_call_id, 'c_1');
  } finally {
    await srv.close();
  }
});

test('openai responses: reasoning item, text and function call', async () => {
  const srv = await startServer((_req, res) =>
    sse(res, [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'Plan: read.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan: read.' }], encrypted_content: 'ENC' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'On it.' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":"c.txt"}' },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"c.txt"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 50, output_tokens: 9, input_tokens_details: { cached_tokens: 20 } } } },
    ], { named: true }),
  );
  try {
    const r = new ModelRegistry();
    r.addProvider({ id: 'openai', api: 'openai-responses', baseUrl: srv.url, apiKeyEnv: ['OPENAI_API_KEY'] });
    const model = r.resolve('openai/gpt-5');
    const final = await complete(model, ctx([user('go')]), { apiKey: 'sk', sessionId: 's1' }, r);
    assert.equal(final.stopReason, 'toolUse', final.error);
    assert.deepEqual(final.content.map((c) => c.type), ['thinking', 'text', 'toolCall']);
    assert.equal((final.content[2] as any).id, 'call_1');
    assert.deepEqual((final.content[2] as any).args, { path: 'c.txt' });
    assert.equal(final.usage.input, 30);
    const body = srv.requests[0].body;
    assert.equal(body.store, false);
    assert.equal(body.prompt_cache_key, 's1');
    assert.equal(body.instructions, 'You are a test.');

    await complete(model, ctx([user('go'), final, { role: 'tool', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: 'C' }], isError: false, ts: 3 }]), { apiKey: 'sk' }, r);
    const input = srv.requests[1].body.input;
    assert.deepEqual(input.map((i: any) => i.type ?? i.role), ['user', 'reasoning', 'message', 'function_call', 'function_call_output']);
    assert.equal(input[1].encrypted_content, 'ENC');
    assert.equal(input[4].call_id, 'call_1');
  } finally {
    await srv.close();
  }
});

test('google: function call with thought signature round trips', async () => {
  const srv = await startServer((_req, res) =>
    sse(res, [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'considering', thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Reading.' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'd.txt' } }, thoughtSignature: 'TS' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 7 } },
    ]),
  );
  try {
    const r = new ModelRegistry();
    r.addProvider({ id: 'google', api: 'google-generative', baseUrl: srv.url, apiKeyEnv: ['GEMINI_API_KEY'] });
    const model = r.resolve('google/gemini-2.5-flash');
    const final = await complete(model, ctx([user('go')]), { apiKey: 'g' }, r);
    assert.equal(final.stopReason, 'toolUse', final.error);
    assert.deepEqual(final.content.map((c) => c.type), ['thinking', 'text', 'toolCall']);
    assert.equal((final.content[2] as any).signature, 'TS');
    assert.equal(final.usage.output, 12);
    assert.match(srv.requests[0].url, /models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse/);
    assert.equal(srv.requests[0].headers['x-goog-api-key'], 'g');
    assert.ok(srv.requests[0].body.tools[0].functionDeclarations[0].parametersJsonSchema);
    const id = (final.content[2] as any).id;
    await complete(model, ctx([user('go'), final, { role: 'tool', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'D' }], isError: false, ts: 3 }]), { apiKey: 'g' }, r);
    const contents = srv.requests[1].body.contents;
    assert.equal(contents[1].role, 'model');
    const fc = contents[1].parts.find((p: any) => p.functionCall);
    assert.equal(fc.thoughtSignature, 'TS');
    assert.equal(contents[2].parts[0].functionResponse.name, 'read');
    assert.deepEqual(contents[2].parts[0].functionResponse.response, { output: 'D' });
  } finally {
    await srv.close();
  }
});

test('retries 429 then succeeds; HTTP errors become error messages', async () => {
  let n = 0;
  const srv = await startServer((req, res) => {
    n++;
    if (req.body?.model === 'bad') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model not found' } }));
      return;
    }
    if (n === 1) {
      res.writeHead(429, { 'retry-after': '0' });
      res.end('slow down');
      return;
    }
    sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']);
  });
  try {
    const r = new ModelRegistry();
    r.addProvider({ id: 'lmstudio', api: 'openai-chat', baseUrl: srv.url, apiKeyOptional: true });
    const ok = await complete(r.resolve('lmstudio/good'), ctx([user('x')]), {}, r);
    assert.equal(ok.stopReason, 'stop');
    assert.equal(n, 2);
    const bad = await complete(r.resolve('lmstudio/bad'), ctx([user('x')]), {}, r);
    assert.equal(bad.stopReason, 'error');
    assert.match(bad.error!, /400.*model not found/);
  } finally {
    await srv.close();
  }
});

test('missing API key yields an error message instead of throwing', async () => {
  const r = new ModelRegistry();
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const m = await complete(r.resolve('sonnet'), ctx([user('x')]), {}, r);
    assert.equal(m.stopReason, 'error');
    assert.match(m.error!, /ANTHROPIC_API_KEY/);
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('abort mid-stream ends with aborted', async () => {
  const srv = await startServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'part' } }] })}\n\n`);
    await new Promise((r) => setTimeout(r, 2000));
    res.end();
  });
  try {
    const r = new ModelRegistry();
    r.addProvider({ id: 'vllm', api: 'openai-chat', baseUrl: srv.url, apiKeyOptional: true });
    const ac = new AbortController();
    const it = stream(r.resolve('vllm/x'), ctx([user('x')]), { signal: ac.signal }, r);
    let final: AssistantMessage | undefined;
    for await (const e of it) {
      if (e.type === 'text_delta') ac.abort();
      if (e.type === 'done' || e.type === 'error') final = e.message;
    }
    assert.equal(final?.stopReason, 'aborted', final?.error);
    assert.equal((final?.content[0] as any).text, 'part');
  } finally {
    await srv.close();
  }
});
