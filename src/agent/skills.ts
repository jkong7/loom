import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Tool } from './tool.ts';
import { textResult } from './tool.ts';
import { parseFrontmatter } from './frontmatter.ts';

export interface Skill {
  name: string;
  description: string;
  path: string;
  dir: string;
  source: string;
}

export function discoverSkills(dirs: string[]): Skill[] {
  const out = new Map<string, Skill>();
  for (const root of dirs) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries.sort()) {
      const dir = join(root, e);
      const file = join(dir, 'SKILL.md');
      try {
        if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
        const { data } = parseFrontmatter<{ name?: string; description?: string }>(readFileSync(file, 'utf8'));
        const name = String(data.name || e).trim();
        const description = String(data.description || '').trim();
        if (!description) continue;
        out.set(name, { name, description: description.slice(0, 1024), path: file, dir, source: root });
      } catch {}
    }
  }
  return [...out.values()];
}

export function renderSkillIndex(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `# Skills\n\nSkills are packaged instructions for specific tasks. When a request matches a skill's description, call the skill tool with its name before starting; it returns the full instructions and the files that come with it.\n\n${lines.join('\n')}`;
}

function listFiles(dir: string, base = dir, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length > 50) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, depth + 1, out);
    else if (e.name !== 'SKILL.md') out.push(relative(base, p));
  }
  return out;
}

export function skillTool(skills: Skill[]): Tool<{ name: string }> {
  return {
    name: 'skill',
    kind: 'read',
    concurrent: true,
    description: `Load a skill's full instructions by name. Available skills: ${skills.map((s) => s.name).join(', ')}.`,
    parameters: { type: 'object', properties: { name: { type: 'string', enum: skills.map((s) => s.name) } }, required: ['name'] },
    async execute(a) {
      const s = skills.find((x) => x.name === a.name);
      if (!s) return textResult(`No skill named "${a.name}"`, true);
      const { body } = parseFrontmatter(readFileSync(s.path, 'utf8'));
      const files = listFiles(dirname(s.path));
      const extra = files.length ? `\n\nFiles in this skill (read them only when the instructions call for it):\n${files.map((f) => `- ${join(s.dir, f)}`).join('\n')}` : '';
      return textResult(`<skill name="${s.name}" dir="${s.dir}">\n${body.trim()}${extra}\n</skill>`);
    },
  };
}
