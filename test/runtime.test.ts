import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers/agent.ts';
import { Runtime } from '../src/runtime.ts';
import { ModelRegistry, MockScript, setMockScript, type Context } from '../src/ai/index.ts';
import { mergeConfig } from '../src/config.ts';
import { parseFrontmatter } from '../src/agent/frontmatter.ts';

function project(): { cwd: string; home: string } {
  const cwd = tempDir('loom-proj-');
  const home = tempDir('loom-home-');
  mkdirSync(join(cwd, '.git'));
  return { cwd, home };
}

async function runtime(cwd: string, home: string, modelId: string, extra: Partial<Parameters<typeof Runtime.create>[0]> = {}) {
  const registry = new ModelRegistry();
  registry.addModel({ provider: 'mock', id: modelId });
  return Runtime.create({ cwd, home, registry, model: `mock/${modelId}`, memory: false, ...extra });
}

test('frontmatter parsing handles lists, folded blocks and scalars', () => {
  const { data, body } = parseFrontmatter<any>('---\nname: x\ndescription: >\n  long\n  text\ntools:\n  - read\n  - grep\nmaxTurns: 5\n---\nBody here\n');
  assert.equal(data.name, 'x');
  assert.equal(data.description, 'long text');
  assert.deepEqual(data.tools, ['read', 'grep']);
  assert.equal(data.maxTurns, 5);
  assert.equal(body.trim(), 'Body here');
});

test('config layers merge: rules concatenate, hooks append, scalars override; .mcp.json is read', async () => {
  const { cwd, home } = project();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ model: 'mock/a', permissions: { allow: ['read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
  mkdirSync(join(cwd, '.loom'));
  writeFileSync(join(cwd, '.loom', 'config.json'), JSON.stringify({ model: 'mock/b', permissions: { allow: ['bash(npm test:*)'], mode: 'acceptEdits' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'nothing', disabled: true } } }));
  process.env.LOOM_HOME = home;
  try {
    const rt = await Runtime.create({ cwd, memory: false, mcp: false });
    assert.equal(rt.config.model, 'mock/b');
    assert.deepEqual(rt.config.permissions?.allow, ['read', 'bash(npm test:*)']);
    assert.equal(rt.permissions.mode, 'acceptEdits');
    assert.equal(rt.hooks.count('Stop'), 2);
    assert.ok(rt.config.mcpServers?.x);
    assert.equal(rt.configFiles.length, 3);
    await rt.close();
  } finally {
    delete process.env.LOOM_HOME;
  }
  assert.deepEqual(mergeConfig({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } }), { a: { b: 1, c: [2], d: 3 } });
});

test('skills: index in the system prompt, body on demand through the skill tool', async () => {
  const { cwd, home } = project();
  const dir = join(cwd, '.loom', 'skills', 'release');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: release\ndescription: Cut a release of this project\n---\n1. Bump the version\n2. Tag it\n');
  writeFileSync(join(dir, 'checklist.md'), 'extra');
  const id = `skills-${Date.now()}`;
  const script = setMockScript(id, new MockScript([{ toolCalls: [{ name: 'skill', args: { name: 'release' } }] }, (ctx: Context) => ({ text: (ctx.messages.at(-1) as any).content[0].text })]));
  const rt = await runtime(cwd, home, id);
  const agent = await rt.createAgent();
  const r = await agent.prompt('cut a release');
  assert.match(script.calls[0].system[0].text, /- release: Cut a release of this project/);
  assert.doesNotMatch(script.calls[0].system[0].text, /Bump the version/);
  assert.match(r.text, /1\. Bump the version/);
  assert.match(r.text, /checklist\.md/);
  await rt.close();
});

test('subagents: task tool runs a child agent with a fresh context and filtered tools, in parallel', async () => {
  const { cwd, home } = project();
  writeFileSync(join(cwd, 'notes.txt'), 'the secret word is mango\n');
  const parentId = `parent-${Date.now()}`;
  const childId = `child-${Date.now()}`;
  mkdirSync(join(cwd, '.loom', 'agents'), { recursive: true });
  writeFileSync(join(cwd, '.loom', 'agents', 'finder.md'), `---\nname: finder\ndescription: finds things\ntools: read, grep\nmodel: mock/${childId}\n---\nYou find words.\n`);
  const childScript = setMockScript(childId, new MockScript([], (ctx: Context) => {
    const last = ctx.messages.at(-1)!;
    if (last.role === 'user') return { toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] };
    return { text: `found: ${(last.content[0] as any).text.split('\t')[1]}` };
  }));
  const parentScript = setMockScript(parentId, new MockScript([
    { toolCalls: [{ name: 'task', args: { description: 'find word', prompt: 'find the secret word', agent: 'finder' } }, { name: 'task', args: { description: 'find again', prompt: 'find it again', agent: 'finder' } }] },
    (ctx: Context) => ({ text: ctx.messages.filter((m) => m.role === 'tool').map((m) => (m.content[0] as any).text.split('\n')[0]).join(' + ') }),
  ]));
  const registry = new ModelRegistry();
  registry.addModel({ provider: 'mock', id: parentId });
  registry.addModel({ provider: 'mock', id: childId });
  const rt = await Runtime.create({ cwd, home, registry, model: `mock/${parentId}`, memory: false });
  const agent = await rt.createAgent();
  const r = await agent.prompt('what is the secret word?');
  assert.equal(r.text, 'found: the secret word is mango + found: the secret word is mango');
  assert.equal(childScript.calls.length, 4);
  const childCtx = childScript.calls[0];
  assert.deepEqual(childCtx.tools!.map((t) => t.name).sort(), ['grep', 'read']);
  assert.match(childCtx.system[0].text, /You find words/);
  assert.equal(childCtx.messages.length, 1);
  assert.ok(parentScript.calls[0].tools!.some((t) => t.name === 'task'));
  const children = rt.sessions.files(cwd).filter((f) => !f.includes(agent.session.id));
  assert.equal(children.length, 2);
  assert.equal(rt.sessions.list(cwd).length, 1);
  await rt.close();
});

test('plugins register tools, hooks, providers and system prompt text', async () => {
  const { cwd, home } = project();
  mkdirSync(join(cwd, '.loom', 'plugins'), { recursive: true });
  writeFileSync(
    join(cwd, '.loom', 'plugins', 'hello.ts'),
    `export default function (api) {
  api.registerTool({ name: 'hello', description: 'say hello', kind: 'read', parameters: { type: 'object', properties: { who: { type: 'string' } } }, execute: async (a) => 'hello ' + a.who });
  api.on('UserPromptSubmit', () => ({ additionalContext: ['plugin was here'] }));
  api.addSystemPrompt('PLUGIN PROMPT');
}
`,
  );
  writeFileSync(join(cwd, '.loom', 'plugins', 'broken.ts'), 'export const x = 1;\n');
  const id = `plug-${Date.now()}`;
  const script = setMockScript(id, new MockScript([{ toolCalls: [{ name: 'hello', args: { who: 'jonny' } }] }, (ctx: Context) => ({ text: (ctx.messages.at(-1) as any).content[0].text })]));
  const rt = await runtime(cwd, home, id);
  assert.equal(rt.pluginHost.loaded.length, 1);
  assert.match(rt.warnings.join('\n'), /broken\.ts: plugin must export a default function/);
  const agent = await rt.createAgent();
  const r = await agent.prompt('greet');
  assert.equal(r.text, 'hello jonny');
  assert.match(script.calls[0].system[0].text, /PLUGIN PROMPT/);
  assert.match(JSON.stringify(script.calls[0].messages[0]), /plugin was here/);
  await rt.close();
});

test('resume continues the latest session with its model; fork copies history', async () => {
  const { cwd, home } = project();
  const id = `res-${Date.now()}`;
  setMockScript(id, new MockScript([{ text: 'first answer' }, { text: 'second answer' }, { text: 'fork answer' }]));
  const rt = await runtime(cwd, home, id);
  const a = await rt.createAgent();
  await a.prompt('hello');
  await a.close();
  const b = await rt.createAgent({ resume: 'latest' });
  assert.equal(b.session.id, a.session.id);
  assert.equal(b.model.id, id);
  const r = await b.prompt('again');
  assert.equal(r.text, 'second answer');
  const c = await rt.createAgent({ fork: { session: a.session.id } });
  assert.notEqual(c.session.id, a.session.id);
  assert.equal(c.session.messages().length, 4);
  await rt.close();
});
