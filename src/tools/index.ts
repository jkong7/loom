import { ToolRegistry, type Tool } from '../agent/tool.ts';
import { readTool, writeTool, editTool } from './fs.ts';
import { bashTool, bashOutputTool, bashKillTool } from './bash.ts';
import { grepTool, globTool } from './search.ts';
import { fetchTool } from './fetch.ts';

export { readTool, writeTool, editTool, applyEdits, resolvePath, withFileLock } from './fs.ts';
export { bashTool, bashOutputTool, bashKillTool, seatbeltProfile, wrapCommand, killAllJobs, type SandboxConfig } from './bash.ts';
export { grepTool, globTool, findRipgrep } from './search.ts';
export { fetchTool, htmlToText } from './fetch.ts';

export const BUILTIN_TOOLS: Tool<any>[] = [readTool, editTool, writeTool, bashTool, bashOutputTool, bashKillTool, grepTool, globTool, fetchTool];

export function builtinTools(opts: { only?: string[]; exclude?: string[] } = {}): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) {
    if (opts.only && !opts.only.includes(t.name)) continue;
    if (opts.exclude?.includes(t.name)) continue;
    r.register(t);
  }
  return r;
}
