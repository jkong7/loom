import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers/agent.ts';
import { Runtime } from '../../src/runtime.ts';

const MODEL = process.env.LOOM_OLLAMA_MODEL || 'qwen3:8b';
const up = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(500) })
  .then(async (r) => (r.ok ? ((await r.json()) as { models: { name: string }[] }).models.some((m) => m.name === MODEL) : false))
  .catch(() => false);

test(`real local model (${MODEL} on Ollama): writes a file with a tool and answers`, { skip: !up && 'ollama not running or model missing', timeout: 600000 }, async () => {
  const cwd = tempDir('loom-ollama-');
  mkdirSync(join(cwd, '.git'));
  const rt = await Runtime.create({ cwd, home: tempDir('loom-home-'), model: `ollama/${MODEL}`, mode: 'acceptEdits', memory: false, mcp: false });
  const agent = await rt.createAgent({ reasoning: 'off' });
  const tools: string[] = [];
  agent.subscribe((e) => {
    if (e.type === 'tool_start') tools.push(e.call.name);
  });
  const r = await agent.prompt('Use the write tool to create notes.txt containing exactly the text: loom works. Then reply with the single word DONE.');
  await rt.close();
  assert.equal(r.reason, 'done', r.error);
  assert.ok(tools.includes('write'), `tools used: ${tools.join(',')}`);
  assert.ok(existsSync(join(cwd, 'notes.txt')));
  assert.match(readFileSync(join(cwd, 'notes.txt'), 'utf8'), /loom works/);
});
