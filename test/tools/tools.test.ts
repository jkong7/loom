import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../helpers/agent.ts';
import { readTool, writeTool, editTool, bashTool, bashOutputTool, grepTool, globTool, applyEdits, htmlToText } from '../../src/tools/index.ts';
import type { ToolContext, ToolResult } from '../../src/agent/tool.ts';

function ctx(cwd: string, services: Record<string, unknown> = {}): ToolContext {
  return { cwd, sessionId: 's', signal: new AbortController().signal, toolCallId: 'c', depth: 0, services: { readFiles: new Map(), ...services } };
}

const text = (r: ToolResult | string) => (typeof r === 'string' ? r : r.content.map((c) => (c.type === 'text' ? c.text : '[img]')).join(''));

test('read numbers lines, pages, and refuses directories', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  const c = ctx(dir);
  assert.equal(text(await readTool.execute({ path: 'a.txt' }, c)), '1\tone\n2\ttwo\n3\tthree');
  assert.match(text(await readTool.execute({ path: 'a.txt', offset: 2, limit: 1 }, c)), /^2\ttwo\n\n\[showing lines 2-2 of 3/);
  assert.equal(((await readTool.execute({ path: '.' }, c)) as ToolResult).isError, true);
  assert.equal(((await readTool.execute({ path: 'missing' }, c)) as ToolResult).isError, true);
});

test('write requires a prior read for existing files; edit enforces unique matches', async () => {
  const dir = tempDir();
  const c = ctx(dir);
  assert.match(text(await writeTool.execute({ path: 'sub/new.ts', content: 'let a = 1;\nlet b = 1;\n' }, c)), /Created sub\/new\.ts/);
  writeFileSync(join(dir, 'old.txt'), 'x');
  assert.equal(((await writeTool.execute({ path: 'old.txt', content: 'y' }, c)) as ToolResult).isError, true);
  const amb = (await editTool.execute({ path: 'sub/new.ts', old_string: '= 1;', new_string: '= 2;' }, c)) as ToolResult;
  assert.equal(amb.isError, true);
  assert.match(text(amb), /matches 2 places/);
  const ok = (await editTool.execute({ path: 'sub/new.ts', edits: [{ old_string: 'let a = 1;', new_string: 'let a = 2;' }, { old_string: 'let b', new_string: 'const b' }] }, c)) as ToolResult;
  assert.equal(ok.isError, false);
  assert.equal(readFileSync(join(dir, 'sub/new.ts'), 'utf8'), 'let a = 2;\nconst b = 1;\n');
  const miss = (await editTool.execute({ path: 'sub/new.ts', old_string: 'let  a = 2;', new_string: 'z' }, c)) as ToolResult;
  assert.match(text(miss), /not found/);
  writeFileSync(join(dir, 'sub/new.ts'), 'changed externally');
  const stale = (await editTool.execute({ path: 'sub/new.ts', old_string: 'changed', new_string: 'x' }, c)) as ToolResult;
  assert.match(text(stale), /changed on disk|Read/);
});

test('applyEdits is atomic', () => {
  const r = applyEdits('abc', [{ old_string: 'a', new_string: 'A' }, { old_string: 'zzz', new_string: 'q' }]);
  assert.ok(r.error);
  assert.equal(r.content, 'abc');
});

test('bash returns output and exit codes, times out, and runs background jobs', async () => {
  const dir = tempDir();
  const c = ctx(dir);
  assert.equal(text(await bashTool.execute({ command: 'echo hi && pwd' }, c)).split('\n')[0], 'hi');
  const fail = (await bashTool.execute({ command: 'echo oops >&2; exit 3' }, c)) as ToolResult;
  assert.equal(fail.isError, true);
  assert.match(text(fail), /oops[\s\S]*exit code 3/);
  const slow = (await bashTool.execute({ command: 'sleep 5', timeout: 1 }, c)) as ToolResult;
  assert.match(text(slow), /timeout/);
  const bg = text(await bashTool.execute({ command: 'echo started; sleep 0.2; echo finished', run_in_background: true }, c));
  const id = bg.match(/job \w+/)![0].split(' ')[1];
  await new Promise((r) => setTimeout(r, 500));
  assert.match(text(await bashOutputTool.execute({ id }, c)), /exited with code 0[\s\S]*started\nfinished/);
});

test('seatbelt sandbox blocks writes outside the working directory', { skip: process.platform !== 'darwin' }, async () => {
  const dir = tempDir();
  const outside = join(homedir(), `.loom-sandbox-probe-${Date.now()}`);
  const c = ctx(dir, { sandbox: { mode: 'seatbelt', network: false } });
  const inside = (await bashTool.execute({ command: 'echo ok > inside.txt && cat inside.txt' }, c)) as ToolResult;
  assert.equal(text(inside), 'ok');
  const blocked = (await bashTool.execute({ command: `echo bad > ${outside}` }, c)) as ToolResult;
  assert.equal(blocked.isError, true);
  assert.equal(existsSync(outside), false);
  assert.match(text(blocked), /Operation not permitted/);
});

test('grep and glob find content and files, skipping node_modules', async () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const needle = 1;\nconst other = 2;\n');
  writeFileSync(join(dir, 'src', 'b.py'), 'needle = 3\n');
  writeFileSync(join(dir, 'node_modules', 'x', 'c.ts'), 'needle\n');
  const c = ctx(dir);
  for (const noRg of [false, true]) {
    if (noRg) process.env.LOOM_NO_RG = '1';
    const files = text(await grepTool.execute({ pattern: 'needle' }, c)).split('\n').sort();
    assert.deepEqual(files, ['src/a.ts', 'src/b.py']);
    assert.match(text(await grepTool.execute({ pattern: 'needle', glob: '*.ts', output_mode: 'content' }, c)), /src\/a\.ts:1:export const needle/);
  }
  delete process.env.LOOM_NO_RG;
  assert.deepEqual(text(await globTool.execute({ pattern: '**/*.ts' }, c)).split('\n'), ['src/a.ts']);
});

test('html to text', () => {
  assert.equal(htmlToText('<html><head><title>x</title></head><body><h1>Hi</h1><p>a &amp; b</p><script>x()</script></body></html>'), '# Hi\na & b');
});

test('write repairs content whose newlines arrived double-escaped', async () => {
  const dir = tempDir();
  const r = await writeTool.execute({ path: 'a.py', content: 'def f():\\n    y = 1\\n    return \\"x\\"\\n' }, ctx(dir));
  assert.equal(readFileSync(join(dir, 'a.py'), 'utf8'), 'def f():\n    y = 1\n    return "x"\n');
  assert.match(text(r), /escaped newlines/);
  const json = '{"a":"x\\ny","b":"z\\nw","c":"\\n"}';
  await writeTool.execute({ path: 'c.txt', content: json }, ctx(dir));
  assert.equal(readFileSync(join(dir, 'c.txt'), 'utf8'), json);
  await writeTool.execute({ path: 'b.txt', content: 'one literal \\n is fine' }, ctx(dir));
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'one literal \\n is fine');
});

test('bubblewrap arguments bind the cwd writable and the rest read only', async () => {
  const { bwrapArgs } = await import('../../src/tools/bash.ts');
  const args = bwrapArgs('echo hi', '/work/proj', { mode: 'bwrap', network: false });
  assert.deepEqual(args.slice(0, 3), ['--ro-bind', '/', '/']);
  assert.ok(args.join(' ').includes('--bind-try /work/proj /work/proj'));
  assert.ok(args.includes('--unshare-net'));
  assert.deepEqual(args.slice(-3), ['/bin/bash', '-c', 'echo hi']);
});
