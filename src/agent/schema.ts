import type { JsonSchema } from '../ai/types.ts';

export function validate(schema: JsonSchema, value: unknown, path = 'args'): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return errors;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(t: string, v: unknown): boolean {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function check(s: JsonSchema, v: unknown, path: string, errors: string[]): void {
  if (!s || typeof s !== 'object') return;
  const anyOf = (s.anyOf || s.oneOf) as JsonSchema[] | undefined;
  if (anyOf) {
    if (!anyOf.some((sub) => validate(sub, v, path).length === 0)) errors.push(`${path} does not match any allowed shape`);
    return;
  }
  if (s.enum && !(s.enum as unknown[]).some((e) => e === v)) {
    errors.push(`${path} must be one of ${(s.enum as unknown[]).map((e) => JSON.stringify(e)).join(', ')}`);
    return;
  }
  const type = s.type as string | string[] | undefined;
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => matchesType(t, v))) {
      errors.push(`${path} must be ${types.join(' or ')}, got ${typeOf(v)}`);
      return;
    }
  }
  if (typeOf(v) === 'object' && (s.properties || s.required)) {
    const obj = v as Record<string, unknown>;
    for (const r of (s.required as string[]) ?? []) if (obj[r] === undefined) errors.push(`${path}.${r} is required`);
    const props = (s.properties as Record<string, JsonSchema>) ?? {};
    for (const [k, sub] of Object.entries(props)) if (obj[k] !== undefined) check(sub, obj[k], `${path}.${k}`, errors);
    if (s.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in props)) errors.push(`${path}.${k} is not allowed`);
    }
  }
  if (typeOf(v) === 'array' && s.items) {
    (v as unknown[]).forEach((item, i) => check(s.items as JsonSchema, item, `${path}[${i}]`, errors));
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${path} must be >= ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${path} must be <= ${s.maximum}`);
  }
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && v.length < s.minLength) errors.push(`${path} must have at least ${s.minLength} characters`);
  }
}

export function coerce(schema: JsonSchema, value: unknown): unknown {
  if (!schema || typeof schema !== 'object') return value;
  const t = schema.type;
  if (t === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema.properties as Record<string, JsonSchema>) ?? {};
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, sub] of Object.entries(props)) if (out[k] !== undefined) out[k] = coerce(sub, out[k]);
    return out;
  }
  if ((t === 'number' || t === 'integer') && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  if (t === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
  if (t === 'array' && typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  if (t === 'array' && Array.isArray(value) && schema.items) return value.map((x) => coerce(schema.items as JsonSchema, x));
  return value;
}
