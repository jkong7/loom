import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers/agent.ts';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'loom.js');

function loom(args: string[], cwd: string, home: string, input = '') {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, LOOM_HOME: home, LOOM_MODEL: '' }, timeout: 120000 });
}

test('cli: print mode with the mock model, json output, resume by --continue', () => {
  const cwd = tempDir('loom-cli-');
  mkdirSync(join(cwd, '.git'));
  const home = tempDir('loom-clihome-');
  const r1 = loom(['-p', 'first message', '-m', 'mock', '--no-memory', '-o', 'json'], cwd, home);
  assert.equal(r1.status, 0, r1.stderr);
  const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.result, 'mock: first message');
  assert.ok(existsSync(j1.transcript_path));
  const r2 = loom(['-p', 'second', '-m', 'mock', '--no-memory', '-c', '-o', 'json'], cwd, home);
  const j2 = JSON.parse(r2.stdout);
  assert.equal(j2.session_id, j1.session_id);
  const lines = readFileSync(j1.transcript_path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.type === 'message');
  assert.deepEqual(lines.map((l) => l.text), ['first message', 'mock: first message', 'second', 'mock: second']);
  const sessions = loom(['sessions'], cwd, home);
  assert.match(sessions.stdout, new RegExp(j1.session_id.slice(0, 8)));
});

test('cli: tool use through bash with an allow rule, stdin prompt, and help', () => {
  const cwd = tempDir('loom-cli-');
  const home = tempDir('loom-clihome-');
  const r = loom(['-p', '-m', 'mock', '--no-memory', '--allow', 'bash(touch:*)'], cwd, home, 'call bash {"command":"touch made-by-loom"}');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(cwd, 'made-by-loom')));
  assert.match(loom(['--help'], cwd, home).stdout, /model-agnostic agent harness/);
  assert.equal(loom(['--bogus'], cwd, home).status, 2);
});
