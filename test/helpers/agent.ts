import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, MockScript, setMockScript, type MockStep, type Model } from '../../src/ai/index.ts';
import { Agent, type AgentOptions } from '../../src/agent/agent.ts';
import { ToolRegistry, type Tool } from '../../src/agent/tool.ts';
import { PermissionPolicy } from '../../src/agent/permissions.ts';
import { HookBus } from '../../src/agent/hooks.ts';
import { Session } from '../../src/agent/session.ts';

let n = 0;

export function tempDir(prefix = 'loom-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface TestAgent {
  agent: Agent;
  script: MockScript;
  model: Model;
  root: string;
  cwd: string;
  events: any[];
}

export function echoTool(name = 'echo', concurrent = true, kind: Tool['kind'] = 'read'): Tool<{ text: string }> {
  return {
    name,
    description: 'Echo text back',
    kind,
    concurrent,
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (a) => `echo:${a.text}`,
  };
}

export function makeAgent(steps: MockStep[], opts: Partial<AgentOptions> & { contextWindow?: number; tools?: ToolRegistry; cwd?: string } = {}): TestAgent {
  const registry = new ModelRegistry();
  const id = `t${++n}-${Date.now()}`;
  const model = registry.addModel({ provider: 'mock', id, contextWindow: opts.contextWindow ?? 200000, maxOutput: 4096 });
  const script = setMockScript(id, new MockScript(steps));
  const root = tempDir();
  const cwd = opts.cwd ?? tempDir('loom-cwd-');
  const session = opts.session ?? Session.create({ root, cwd, model: `mock/${id}` });
  const tools = opts.tools ?? new ToolRegistry().register(echoTool());
  const agent = new Agent({
    model,
    registry,
    session,
    tools,
    permissions: opts.permissions ?? new PermissionPolicy(),
    hooks: opts.hooks ?? new HookBus(),
    ...opts,
  } as AgentOptions);
  const events: any[] = [];
  agent.subscribe((e) => events.push(e));
  return { agent, script, model, root, cwd, events };
}
