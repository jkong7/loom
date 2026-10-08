export interface Parsed<T = Record<string, unknown>> {
  data: T;
  body: string;
}

function scalar(v: string): unknown {
  const t = v.trim();
  if (t === '') return '';
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).split(',').map((x) => String(scalar(x))).filter(Boolean);
  return t;
}

export function parseFrontmatter<T = Record<string, unknown>>(text: string): Parsed<T> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {} as T, body: text };
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;
  let blockKey: string | null = null;
  const block: string[] = [];
  const flush = () => {
    if (blockKey) data[blockKey] = block.join(' ').trim();
    blockKey = null;
    block.length = 0;
  };
  for (const raw of m[1].split(/\r?\n/)) {
    if (blockKey && /^\s+\S/.test(raw)) {
      block.push(raw.trim());
      continue;
    }
    flush();
    const item = raw.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as unknown[]).push(scalar(item[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    listKey = null;
    const [, k, v] = kv;
    if (v === '') {
      data[k] = [];
      listKey = k;
    } else if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      blockKey = k;
    } else data[k] = scalar(v);
  }
  flush();
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && !v.length) data[k] = '';
  return { data: data as T, body: m[2] };
}
