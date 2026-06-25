/**
 * MEMORY_VERBS v1 — conformance runner core (E2).
 *
 * Executes the embedded fixture set (conformance-fixtures.ts) against any MCP
 * endpoint via a minimal client surface (list_tools + call_tool only) and
 * returns a pass/fail table. Transport-agnostic: the CLI wraps it with stdio
 * spawn / HTTP transports; the negative self-test [F3] feeds it a mutated
 * in-process double.
 *
 * Validation is deliberately NON-STRICT on extra fields — the contract is
 * additive-forever, so unknown fields are always legal. A certifier that
 * rejected additions would break the versioning policy it certifies.
 */

import { RESPONSE_SCHEMAS, ERROR_SCHEMA, MEMORY_VERBS_VERSION, type VerbName } from '../verbs.ts';
import { CONFORMANCE_CASES, type ConformanceCase } from './conformance-fixtures.ts';

export interface ConformanceClient {
  listTools(): Promise<Array<{ name: string; description?: string; annotations?: unknown }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
}

export interface CaseResult {
  name: string;
  verb: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface ConformanceReport {
  protocol_version: number;
  results: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
}

/**
 * Minimal JSON-Schema-subset validator: type (incl. union arrays + integer),
 * required, properties (NON-strict), enum, const, items. Returns violations
 * as "path: problem" strings.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = '$',
): string[] {
  const out: string[] = [];
  const t = schema.type as string | string[] | undefined;
  if (t !== undefined) {
    const types = Array.isArray(t) ? t : [t];
    if (!types.some(ty => matchesType(value, ty))) {
      out.push(`${path}: expected ${types.join('|')}, got ${describe(value)}`);
      return out; // structural mismatch — deeper checks are noise
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    out.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && value !== null && !schema.enum.includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} not in enum [${(schema.enum as unknown[]).join(', ')}]`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) out.push(`${path}.${req}: required field missing`);
    }
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj && obj[k] !== undefined) out.push(...validateAgainstSchema(obj[k], sub, `${path}.${k}`));
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    value.forEach((item, i) =>
      out.push(...validateAgainstSchema(item, schema.items as Record<string, unknown>, `${path}[${i}]`)),
    );
  }
  return out;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return false;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function substitute(value: unknown, marker: string, ids: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let s = value.replaceAll('{{marker}}', marker);
    s = s.replace(/\{\{id:([a-z0-9_-]+)\}\}/gi, (_, key) => ids.get(key) ?? `MISSING-ID-${key}`);
    return s;
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, marker, ids));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, marker, ids)]));
  }
  return value;
}

function runChecks(body: unknown, checks: NonNullable<ConformanceCase['expect']>): string[] {
  const problems: string[] = [];
  for (const c of checks) {
    const v = getPath(body, c.path);
    if ('equals' in c) {
      if (v !== c.equals) problems.push(`${c.path}: expected ${JSON.stringify(c.equals)}, got ${JSON.stringify(v)}`);
    } else if ('oneOf' in c) {
      if (!c.oneOf.includes(v)) problems.push(`${c.path}: ${JSON.stringify(v)} not in ${JSON.stringify(c.oneOf)}`);
    } else if ('type' in c) {
      if (!matchesType(v, c.type)) problems.push(`${c.path}: expected ${c.type}, got ${describe(v)}`);
    } else if ('gte' in c) {
      if (typeof v !== 'number' || v < c.gte) problems.push(`${c.path}: expected >= ${c.gte}, got ${JSON.stringify(v)}`);
    } else if ('lte' in c) {
      if (typeof v !== 'number' || v > c.lte) problems.push(`${c.path}: expected <= ${c.lte}, got ${JSON.stringify(v)}`);
    } else if ('nonEmptyString' in c) {
      if (typeof v !== 'string' || !v.trim()) problems.push(`${c.path}: expected non-empty string`);
    } else if ('absentOrNotContains' in c) {
      const json = v === undefined ? '' : JSON.stringify(v);
      if (json.includes(c.absentOrNotContains)) problems.push(`${c.path}: must not contain "${c.absentOrNotContains}"`);
    }
  }
  return problems;
}

export async function runConformance(
  client: ConformanceClient,
  opts: { marker?: string; synthesize?: boolean } = {},
): Promise<ConformanceReport> {
  const marker = opts.marker ?? `run-${Date.now().toString(36)}`;
  const ids = new Map<string, string>();
  const results: CaseResult[] = [];

  // Seed the conformance entity PAGE when the target exposes put_page (full
  // surface). entity() resolves pages; verbs-only targets with no seeding
  // path skip the entity-hit cases honestly (requiresSeededEntity).
  let seededEntity = false;
  try {
    const seed = await client.callTool('put_page', {
      slug: `people/conformance-${marker}`,
      content: `---\ntitle: Conformance ${marker}\ntype: person\n---\n\n# Conformance ${marker}\n\nSynthetic entity for a MEMORY_VERBS conformance run.\n`,
    });
    seededEntity = !seed.isError;
  } catch {
    seededEntity = false;
  }

  // List-level checks first: the five verbs are advertised, synthesize is
  // marked expensive (description prefix is the load-bearing channel).
  try {
    const tools = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));
    for (const verb of Object.keys(RESPONSE_SCHEMAS) as VerbName[]) {
      results.push(
        byName.has(verb)
          ? { name: `tools/list advertises ${verb}`, verb, status: 'pass', detail: '' }
          : { name: `tools/list advertises ${verb}`, verb, status: 'fail', detail: 'not advertised' },
      );
    }
    const synth = byName.get('synthesize');
    const marked = !!synth?.description?.startsWith('[EXPENSIVE');
    results.push({
      name: 'synthesize is marked expensive ([EXPENSIVE prefix)',
      verb: 'synthesize',
      status: marked ? 'pass' : 'fail',
      detail: marked ? '' : `description starts: "${synth?.description?.slice(0, 40) ?? '(missing)'}..."`,
    });
  } catch (e) {
    results.push({
      name: 'tools/list',
      verb: '-',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  for (const c of CONFORMANCE_CASES) {
    if (c.requiresSynthesizeFlag && !opts.synthesize) {
      results.push({ name: c.name, verb: c.verb, status: 'skip', detail: 'costs money — pass --synthesize' });
      continue;
    }
    if (c.requiresSeededEntity && !seededEntity) {
      results.push({ name: c.name, verb: c.verb, status: 'skip', detail: 'target has no put_page to seed the entity page (verbs-only surface)' });
      continue;
    }
    const params = substitute(c.params, marker, ids) as Record<string, unknown>;
    let res: { isError?: boolean; text: string };
    try {
      res = await client.callTool(c.verb, params);
    } catch (e) {
      results.push({ name: c.name, verb: c.verb, status: 'fail', detail: `transport: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      results.push({ name: c.name, verb: c.verb, status: 'fail', detail: `response not JSON: ${res.text.slice(0, 120)}` });
      continue;
    }

    const problems: string[] = [];

    if (c.verb === 'synthesize' && c.requiresSynthesizeFlag) {
      // Accept either a schema-valid answer (key configured) or a clean
      // `unavailable` protocol error (no key). Anything else fails.
      if (res.isError) {
        const err = body as { error?: string; suggestion?: string };
        if (err.error !== 'unavailable') problems.push(`expected unavailable, got error=${err.error}`);
        if (!err.suggestion?.trim()) problems.push('error.suggestion empty');
        problems.push(...validateAgainstSchema(body, ERROR_SCHEMA, '$err'));
      } else {
        problems.push(...validateAgainstSchema(body, RESPONSE_SCHEMAS.synthesize));
      }
    } else if (c.expectErrorCode) {
      if (!res.isError) {
        problems.push(`expected error ${c.expectErrorCode}, got success`);
      } else {
        const err = body as { error?: string; suggestion?: string; protocol_version?: number };
        if (err.error !== c.expectErrorCode) problems.push(`expected error=${c.expectErrorCode}, got ${err.error}`);
        if (c.expectSuggestion && !err.suggestion?.trim()) problems.push('error.suggestion empty (F-D mandate)');
      }
    } else {
      if (res.isError) {
        problems.push(`unexpected error: ${res.text.slice(0, 160)}`);
      } else {
        if (c.validateSchema) problems.push(...validateAgainstSchema(body, RESPONSE_SCHEMAS[c.verb]));
        if (c.expect) problems.push(...runChecks(body, c.expect));
        if (c.saveAs) {
          const v = getPath(body, c.saveAs.path);
          if (typeof v === 'string') ids.set(c.saveAs.key, v);
          else problems.push(`saveAs ${c.saveAs.path}: expected string id, got ${describe(v)}`);
        }
      }
    }

    results.push(
      problems.length === 0
        ? { name: c.name, verb: c.verb, status: 'pass', detail: '' }
        : { name: c.name, verb: c.verb, status: 'fail', detail: problems.join('; ') },
    );
  }

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  return { protocol_version: MEMORY_VERBS_VERSION, results, passed, failed, skipped, ok: failed === 0 };
}
