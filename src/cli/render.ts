import type { AgentEvent } from '../agent/agent.ts';
import type { Message, ToolCallPart, Usage } from '../ai/types.ts';
import { textOf } from '../ai/types.ts';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export function summarizeArgs(call: ToolCallPart): string {
  const a = call.args as Record<string, unknown>;
  const main = a.command ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.name ?? a.description ?? a.prompt ?? a.text;
  const s = typeof main === 'string' ? main : JSON.stringify(a);
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > 100 ? oneLine.slice(0, 97) + '...' : oneLine;
}

export function summarizeResult(m: Message, verbose: boolean): string {
  const text = textOf(m.content, { includeMeta: true });
  if (verbose) return text;
  const lines = text.split('\n');
  const first = lines.slice(0, 3).join('\n');
  return lines.length > 3 ? `${first}\n${c.gray(`... ${lines.length - 3} more lines`)}` : first;
}

export function formatUsage(u: Usage): string {
  const parts = [`in ${u.input}`, `out ${u.output}`];
  if (u.cacheRead) parts.push(`cache read ${u.cacheRead}`);
  if (u.cacheWrite) parts.push(`cache write ${u.cacheWrite}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  return parts.join(', ');
}

export class TextRenderer {
  private out: NodeJS.WritableStream;
  private verbose: boolean;
  private inText = false;
  private inThinking = false;
  private lineStart = true;

  constructor(out: NodeJS.WritableStream, verbose = false) {
    this.out = out;
    this.verbose = verbose;
  }

  private write(s: string): void {
    if (!s) return;
    this.out.write(s);
    this.lineStart = s.endsWith('\n');
  }

  private endBlock(): void {
    if (!this.lineStart) this.write('\n');
    this.inText = false;
    this.inThinking = false;
  }

  handle(e: AgentEvent): void {
    switch (e.type) {
      case 'message_update': {
        const ev = e.event;
        if (ev.type === 'text_delta') {
          if (!this.inText) {
            this.endBlock();
            this.inText = true;
          }
          this.write(ev.delta);
        } else if (ev.type === 'thinking_delta' && this.verbose) {
          if (!this.inThinking) {
            this.endBlock();
            this.inThinking = true;
          }
          this.write(c.dim(ev.delta));
        }
        break;
      }
      case 'tool_start':
        this.endBlock();
        this.write(`${c.cyan('●')} ${c.bold(e.call.name)}${c.gray('(')}${summarizeArgs(e.call)}${c.gray(')')}\n`);
        break;
      case 'tool_end': {
        const body = summarizeResult(e.result, this.verbose);
        const mark = e.result.isError ? c.red('  ✗ ') : c.gray('  ⎿ ');
        this.write(mark + body.split('\n').join('\n    ') + '\n');
        break;
      }
      case 'compaction':
        this.endBlock();
        if (e.phase === 'start') this.write(c.yellow(`[compacting context: ${e.tokensBefore} tokens, ${e.reason}]\n`));
        else if (e.phase === 'end') this.write(c.yellow(`[compacted to about ${e.tokensAfter} tokens]\n`));
        else this.write(c.yellow(`[pruned old tool output: ${e.tokensBefore} to ${e.tokensAfter} tokens]\n`));
        break;
      case 'memory':
        if (this.verbose) {
          this.endBlock();
          this.write(c.magenta(`[memory ${e.kind}]\n`) + c.dim(e.text) + '\n');
        } else if (e.kind === 'recall') {
          this.endBlock();
          const n = (e.text.match(/^- /gm) ?? []).length;
          this.write(c.magenta(`[recalled ${n || 'some'} memor${n === 1 ? 'y' : 'ies'}]\n`));
        }
        break;
      case 'notice':
        this.endBlock();
        this.write((e.level === 'error' ? c.red : e.level === 'warn' ? c.yellow : c.gray)(`[${e.text}]\n`));
        break;
      case 'permission':
        if (e.decision === 'deny' && this.verbose) this.write(c.red(`  permission denied: ${e.reason}\n`));
        break;
      case 'agent_end':
        this.endBlock();
        break;
    }
  }
}

export function toStreamJson(e: AgentEvent, sessionId: string): Record<string, unknown> | null {
  switch (e.type) {
    case 'agent_start':
      return { type: 'system', subtype: 'init', session_id: e.sessionId };
    case 'message_update':
      if (e.event.type === 'text_delta') return { type: 'text_delta', session_id: sessionId, text: e.event.delta };
      if (e.event.type === 'thinking_delta') return { type: 'thinking_delta', session_id: sessionId, text: e.event.delta };
      return null;
    case 'message_end':
      return { type: e.message.role === 'tool' ? 'tool_result' : e.message.role, session_id: sessionId, message: e.message };
    case 'tool_start':
      return { type: 'tool_use', session_id: sessionId, id: e.call.id, name: e.call.name, input: e.call.args };
    case 'compaction':
      return { type: 'system', subtype: `compaction_${e.phase}`, session_id: sessionId, reason: e.reason, tokens_before: e.tokensBefore, tokens_after: e.tokensAfter };
    case 'memory':
      return { type: 'system', subtype: `memory_${e.kind}`, session_id: sessionId, text: e.text };
    case 'notice':
      return { type: 'system', subtype: 'notice', level: e.level, session_id: sessionId, text: e.text };
    case 'permission':
      return { type: 'system', subtype: 'permission', session_id: sessionId, tool: e.tool, decision: e.decision, reason: e.reason };
    default:
      return null;
  }
}
