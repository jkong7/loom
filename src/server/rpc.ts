import { createInterface } from 'node:readline';
import type { Agent } from '../agent/agent.ts';
import type { Runtime } from '../runtime.ts';
import type { PermissionBroker } from './http.ts';

export async function runRpc(rt: Runtime, broker: PermissionBroker, initial: Agent, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  let agent = initial;
  const out = (obj: unknown) => output.write(JSON.stringify(obj) + '\n');
  let off = agent.subscribe((e) => out({ type: 'event', event: e }));
  broker.onRequest((id, r) => out({ type: 'permission_request', id, tool: r.tool, reason: r.reason, target: r.target, args: r.args }));
  await agent.start();
  out({ type: 'ready', session_id: agent.session.id, model: `${agent.model.provider}/${agent.model.id}` });
  const rl = createInterface({ input });
  const running = new Set<Promise<unknown>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let cmd: any;
    try {
      cmd = JSON.parse(line);
    } catch {
      out({ type: 'error', error: 'invalid JSON' });
      continue;
    }
    const reply = (data: object) => out({ type: 'response', id: cmd.id, command: cmd.type, ...data });
    try {
      switch (cmd.type) {
        case 'prompt': {
          if (agent.isRunning) {
            reply({ ok: false, error: 'busy; send steer or abort' });
            break;
          }
          const p = agent.prompt(String(cmd.text ?? '')).then(
            (r) => reply({ ok: true, reason: r.reason, text: r.text, usage: r.usage, turns: r.turns, error: r.error }),
            (err) => reply({ ok: false, error: (err as Error).message }),
          );
          running.add(p);
          p.finally(() => running.delete(p));
          break;
        }
        case 'steer':
          agent.steer(String(cmd.text ?? ''));
          reply({ ok: true });
          break;
        case 'follow_up':
          agent.followUp(String(cmd.text ?? ''));
          reply({ ok: true });
          break;
        case 'abort':
          agent.abort();
          reply({ ok: true });
          break;
        case 'compact':
          if (agent.isRunning) {
            reply({ ok: false, error: 'busy; compaction runs automatically between turns' });
            break;
          }
          reply({ ok: true, ...(await agent.compact({ reason: 'manual', instructions: cmd.instructions })) });
          break;
        case 'permission_response':
          reply({ ok: broker.answer(String(cmd.request_id ?? cmd.id), cmd.answer ?? 'deny') });
          break;
        case 'get_messages':
          reply({ ok: true, messages: agent.session.messages() });
          break;
        case 'set_model':
          agent.setModel(rt.resolveModel(String(cmd.model)));
          reply({ ok: true, model: `${agent.model.provider}/${agent.model.id}` });
          break;
        case 'new': {
          await agent.close('rpc-new');
          off();
          agent = await rt.createAgent({ model: cmd.model, agentContext: 'headless' });
          off = agent.subscribe((e) => out({ type: 'event', event: e }));
          await agent.start();
          reply({ ok: true, session_id: agent.session.id });
          break;
        }
        default:
          reply({ ok: false, error: `unknown command ${cmd.type}` });
      }
    } catch (err) {
      reply({ ok: false, error: (err as Error).message });
    }
  }
  await Promise.allSettled([...running]);
  off();
  await rt.close();
}
