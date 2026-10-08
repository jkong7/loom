import { isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionTarget, Tool } from './tool.ts';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'yolo';
export type Decision = 'allow' | 'deny' | 'ask';

export interface PermissionRules {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

export interface PermissionRequest {
  tool: string;
  args: Record<string, unknown>;
  target: PermissionTarget;
  reason: string;
}

export type PermissionAnswer = 'allow' | 'deny' | 'always';
export type Asker = (req: PermissionRequest) => Promise<PermissionAnswer>;

export interface PermissionOutcome {
  decision: 'allow' | 'deny';
  reason: string;
  rule?: string;
}

function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function parseRule(rule: string): { tool: string; pattern?: string } {
  const m = rule.match(/^([^()]+)\((.*)\)$/);
  return m ? { tool: m[1].trim(), pattern: m[2].trim() } : { tool: rule.trim() };
}

function toolMatches(ruleTool: string, name: string, kind: string): boolean {
  if (ruleTool === '*' || ruleTool === name || ruleTool === `kind:${kind}`) return true;
  if (ruleTool.includes('*')) return globToRegex(ruleTool.replace(/\*/g, '**')).test(name);
  return false;
}

function subjectMatches(pattern: string, target: PermissionTarget, cwd: string): boolean {
  if (target.kind === 'execute' && target.subject !== undefined) {
    const cmd = target.subject.trim();
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -2).trim();
      return cmd === prefix || cmd.startsWith(prefix + ' ');
    }
    return pattern.includes('*') ? globToRegex(pattern.replace(/\*/g, '**')).test(cmd) : cmd === pattern;
  }
  const subjects = target.paths?.length ? target.paths : target.subject ? [target.subject] : [];
  if (!subjects.length) return false;
  const re = globToRegex(pattern.startsWith('/') || pattern.startsWith('~') ? expandHome(pattern) : resolve(cwd, pattern));
  const reRel = globToRegex(pattern);
  return subjects.every((s) => re.test(isAbsolute(s) ? s : resolve(cwd, s)) || reRel.test(s) || reRel.test(relative(cwd, resolve(cwd, s))));
}

function expandHome(p: string): string {
  return p.startsWith('~') ? (process.env.HOME || '') + p.slice(1) : p;
}

export function matchRule(rule: string, tool: Tool<any>, target: PermissionTarget, cwd: string): boolean {
  const { tool: rt, pattern } = parseRule(rule);
  if (!toolMatches(rt, tool.name, tool.kind)) return false;
  if (pattern === undefined || pattern === '*' || pattern === '**') return true;
  return subjectMatches(pattern, target, cwd);
}

export function insideDir(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(dir, path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const SAFE_COMMANDS = /^(ls|pwd|cat|head|tail|wc|echo|which|whoami|date|git (status|diff|log|show|rev-parse|remote -v)|rg|grep|find|tree|file|stat|du|uniq|node --version|npm (ls|view)|python3? --version)(\s|$)/;

export function isReadOnlyCommand(cmd: string): boolean {
  if (/[;&`$<>]|\n/.test(cmd)) return false;
  if (/\s-(exec|execdir|delete|ok|fprint)\b|--output\b/.test(cmd)) return false;
  return cmd.split('|').every((seg) => SAFE_COMMANDS.test(seg.trim()));
}

export class PermissionPolicy {
  mode: PermissionMode;
  rules: Required<PermissionRules>;
  asker?: Asker;
  private sessionAllows: string[] = [];
  extraWritableDirs: string[];

  constructor(opts: { mode?: PermissionMode; rules?: PermissionRules; asker?: Asker; writableDirs?: string[] } = {}) {
    this.mode = opts.mode ?? 'default';
    this.rules = { allow: [...(opts.rules?.allow ?? [])], deny: [...(opts.rules?.deny ?? [])], ask: [...(opts.rules?.ask ?? [])] };
    this.asker = opts.asker;
    this.extraWritableDirs = opts.writableDirs ?? [tmpdir()];
  }

  evaluate(tool: Tool<any>, target: PermissionTarget, cwd: string): { decision: Decision; reason: string; rule?: string } {
    for (const r of this.rules.deny) if (matchRule(r, tool, target, cwd)) return { decision: 'deny', reason: `denied by rule ${r}`, rule: r };
    if (this.mode === 'plan' && tool.kind !== 'read' && tool.kind !== 'agent' && !(tool.kind === 'memory' && tool.name !== 'memory_forget')) {
      return { decision: 'deny', reason: 'plan mode is read only; describe the change instead of making it' };
    }
    for (const r of this.rules.ask) if (matchRule(r, tool, target, cwd)) return { decision: 'ask', reason: `rule ${r} requires approval`, rule: r };
    for (const r of [...this.rules.allow, ...this.sessionAllows]) if (matchRule(r, tool, target, cwd)) return { decision: 'allow', reason: `allowed by rule ${r}`, rule: r };
    if (this.mode === 'yolo') return { decision: 'allow', reason: 'yolo mode' };
    switch (tool.kind) {
      case 'read':
      case 'agent':
        return { decision: 'allow', reason: 'read only' };
      case 'memory':
        return tool.name === 'memory_forget' ? { decision: 'ask', reason: 'forgetting memories is destructive' } : { decision: 'allow', reason: 'memory tools are allowed' };
      case 'edit': {
        const paths = target.paths ?? [];
        const inside = paths.every((p) => insideDir(p, cwd) || this.extraWritableDirs.some((d) => insideDir(p, d)));
        if (this.mode === 'acceptEdits' && inside) return { decision: 'allow', reason: 'acceptEdits mode' };
        return { decision: 'ask', reason: inside ? 'file edit' : 'file edit outside the working directory' };
      }
      case 'execute':
        if (target.subject && isReadOnlyCommand(target.subject)) return { decision: 'allow', reason: 'read-only command' };
        return { decision: 'ask', reason: 'shell command' };
      default:
        return { decision: 'ask', reason: `${tool.kind} tool` };
    }
  }

  async check(tool: Tool<any>, args: Record<string, unknown>, cwd: string, hint?: Decision): Promise<PermissionOutcome> {
    const target = tool.target ? tool.target(args, { cwd }) : { kind: tool.kind, subject: undefined };
    let { decision, reason, rule } = this.evaluate(tool, target, cwd);
    if (decision !== 'deny' && hint === 'deny') return { decision: 'deny', reason: 'denied by hook' };
    if (decision === 'ask' && hint === 'allow') return { decision: 'allow', reason: 'allowed by hook' };
    if (decision !== 'ask') return { decision, reason, rule };
    if (!this.asker) return { decision: 'deny', reason: `${reason}: approval required but no approver is attached (run interactively, add an allow rule, or use --mode acceptEdits/yolo)` };
    const answer = await this.asker({ tool: tool.name, args, target, reason });
    if (answer === 'always') {
      this.sessionAllows.push(suggestRule(tool, target));
      return { decision: 'allow', reason: 'approved for this session' };
    }
    return answer === 'allow' ? { decision: 'allow', reason: 'approved' } : { decision: 'deny', reason: 'the user denied this action' };
  }
}

export function suggestRule(tool: Tool<any>, target: PermissionTarget): string {
  if (target.kind === 'execute' && target.subject) {
    const words = target.subject.trim().split(/\s+/).slice(0, 2).join(' ');
    return `${tool.name}(${words}:*)`;
  }
  return tool.name;
}
