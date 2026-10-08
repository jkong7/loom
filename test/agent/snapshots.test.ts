import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeAgent, tempDir } from '../helpers/agent.ts';
import { Snapshots } from '../../src/agent/snapshots.ts';
import { ToolRegistry } from '../../src/agent/tool.ts';
import { writeTool, readTool } from '../../src/tools/index.ts';
import { PermissionPolicy } from '../../src/agent/permissions.ts';

test('undo restores edited files, removes created ones, and rewinds the conversation', async () => {
  const cwd = tempDir('loom-snap-');
  writeFileSync(join(cwd, 'keep.txt'), 'original\n');
  writeFileSync(join(cwd, '.gitignore'), 'ignored.txt\n');
  const snapshots = new Snapshots(cwd, tempDir('loom-snaproot-'));
  const { agent } = makeAgent(
    [
      { text: 'ok' },
      { toolCalls: [{ name: 'read', args: { path: 'keep.txt' } }] },
      { toolCalls: [{ name: 'write', args: { path: 'keep.txt', content: 'changed\n' } }, { name: 'write', args: { path: 'new.txt', content: 'new\n' } }] },
      { text: 'done' },
    ],
    { cwd, snapshots, tools: new ToolRegistry().register(readTool).register(writeTool), permissions: new PermissionPolicy({ mode: 'yolo' }) },
  );
  await agent.prompt('hello');
  writeFileSync(join(cwd, 'ignored.txt'), 'untracked by snapshots');
  await agent.prompt('change things');
  assert.equal(readFileSync(join(cwd, 'keep.txt'), 'utf8'), 'changed\n');
  assert.ok(existsSync(join(cwd, 'new.txt')));
  const r = await agent.undo();
  assert.ok(r);
  assert.equal(r!.prompt, 'change things');
  assert.deepEqual(r!.restored, ['keep.txt']);
  assert.deepEqual(r!.removed, ['new.txt']);
  assert.equal(readFileSync(join(cwd, 'keep.txt'), 'utf8'), 'original\n');
  assert.equal(existsSync(join(cwd, 'new.txt')), false);
  assert.ok(existsSync(join(cwd, 'ignored.txt')));
  assert.deepEqual(agent.session.messages().map((m) => m.role), ['user', 'assistant']);
});
