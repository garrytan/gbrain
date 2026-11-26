/**
 * gbrain's telemetry backend (supabase/gbrain-telemetry/, GST-3414) stays in
 * step with itself and stays locked down. Read statically, as gstack's
 * supabase-telemetry-schema test does: the Deno function is never imported.
 *
 *  - the ingest's fixed lists are a copy of enums.json, and its field checks
 *    (validate.ts, imported directly) drop anything off a list or shape;
 *  - every SQL CHECK list equals its enums.json list;
 *  - every column the ingest writes exists in G001;
 *  - every object is gbrain_-prefixed, revoked from PUBLIC, anon and
 *    authenticated, RLS is on with no policy, and nothing reads a non-gbrain
 *    table (the condition gstack's owner set for sharing the project);
 *  - verify.sh probes every object G001 creates.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import enumsJson from '../src/core/telemetry/enums.json';
import { toRow } from '../supabase/gbrain-telemetry/functions/gbrain-telemetry-ingest/validate.ts';

const DIR = join(import.meta.dir, '..', 'supabase', 'gbrain-telemetry');
const ENUMS: Record<string, string[]> = enumsJson;
const SQL = readFileSync(join(DIR, 'migrations', 'G001_gbrain_telemetry.sql'), 'utf-8');
const INGEST = readFileSync(join(DIR, 'functions', 'gbrain-telemetry-ingest', 'index.ts'), 'utf-8');
const VALIDATE = readFileSync(join(DIR, 'functions', 'gbrain-telemetry-ingest', 'validate.ts'), 'utf-8');
const PULSE = readFileSync(join(DIR, 'functions', 'gbrain-telemetry-pulse', 'index.ts'), 'utf-8');
const VERIFY = readFileSync(join(DIR, 'verify.sh'), 'utf-8');
const SQL_CODE = SQL.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');

const tables = [...SQL_CODE.matchAll(/CREATE TABLE IF NOT EXISTS public\.(\w+)/g)].map(m => m[1]);
const views = [...SQL_CODE.matchAll(/CREATE OR REPLACE VIEW public\.(\w+)/g)].map(m => m[1]);
const functions = [...SQL_CODE.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map(m => m[1]);

describe('gbrain telemetry backend: one set of fixed lists', () => {
  test('the ingest carries an exact copy of enums.json between its markers', () => {
    const m = VALIDATE.match(/\/\/ BEGIN ENUMS[^\n]*\nexport const ENUMS: Record<string, string\[\]> = ([\s\S]*?);\n\/\/ END ENUMS/);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(ENUMS);
  });

  test('every SQL CHECK list equals its enums.json list', () => {
    const checks = [...SQL_CODE.matchAll(/^\s+(\w+) TEXT(?: NOT NULL)? CHECK \(\1 IN \(([^)]*)\)\)/gm)];
    expect(checks.length).toBeGreaterThan(15);
    for (const [, col, list] of checks) {
      const values = list.split(',').map(s => s.trim().replace(/^'|'$/g, ''));
      const key = col === 'event_type' ? 'event_type' : col;
      expect({ col, values }).toEqual({ col, values: ENUMS[key] });
    }
  });

  test('every column the ingest writes is a column of gbrain_telemetry_events', () => {
    const table = SQL_CODE.match(/CREATE TABLE IF NOT EXISTS public\.gbrain_telemetry_events \(([\s\S]*?)\n\);/)![1];
    const columns = new Set([...table.matchAll(/^\s+(\w+) [A-Z]/gm)].map(m => m[1]));
    const rowBlock = VALIDATE.match(/const row: Row = \{([\s\S]*?)\n  \};/)![1];
    const written = [...rowBlock.matchAll(/^\s+(\w+)[,:]/gm)].map(m => m[1]);
    expect(written.length).toBeGreaterThan(30);
    expect(written.filter(c => !columns.has(c))).toEqual([]);
  });
});

describe('gbrain telemetry backend: locked down and separate from gstack', () => {
  test('every object is gbrain_-prefixed', () => {
    expect(tables.length).toBe(4);
    expect([...tables, ...views, ...functions].filter(n => !n.startsWith('gbrain_'))).toEqual([]);
  });

  test('nothing reads or grants on a table outside gbrain_', () => {
    const refs = [...SQL_CODE.matchAll(/public\.(\w+)/g)].map(m => m[1]);
    expect(refs.filter(n => !n.startsWith('gbrain_'))).toEqual([]);
    for (const src of [INGEST, PULSE]) {
      const used = [...src.matchAll(/\.(?:from|rpc)\("(\w+)"/g)].map(m => m[1]);
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter(n => !n.startsWith('gbrain_'))).toEqual([]);
    }
  });

  test('RLS is on for every table and no policy exists', () => {
    for (const t of tables) expect(SQL_CODE).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
    expect(SQL_CODE).not.toMatch(/CREATE POLICY/i);
  });

  test('every table, the view and every function is revoked from PUBLIC, anon and authenticated', () => {
    const revokes = [...SQL_CODE.matchAll(/REVOKE (?:ALL|EXECUTE) ON ([\s\S]*?) FROM PUBLIC, anon, authenticated;/g)].map(m => m[1]).join(' ');
    for (const n of [...tables, ...views, ...functions]) expect(revokes).toContain(`public.${n}`);
    expect(SQL_CODE).not.toMatch(/GRANT [^;]* TO [^;]*\b(anon|authenticated|PUBLIC)\b/);
  });

  test('verify.sh probes every object G001 creates', () => {
    for (const n of [...tables, ...views, ...functions]) expect(VERIFY).toContain(n);
  });

  // Value: protects=verify.sh calls each function with exactly its SQL parameter names, so PostgREST reaches the permission check (42501) instead of PGRST202; fails_when=a probe sends {} to a function that takes arguments, or a parameter is renamed; why_new=the probe test checks names only; seam=none; no_claim=a live PostgREST answer (static check against G001)
  test('verify.sh calls each function with its SQL parameter names', () => {
    const fn = VERIFY.match(/^rpc_args\(\) \{[\s\S]*?\n\}/m)![0];
    for (const f of functions) {
      const params = SQL_CODE.match(new RegExp(`FUNCTION public\\.${f}\\(([^)]*)\\)`))![1];
      const want = [...params.matchAll(/\b(p_\w+)\b/g)].map(m => m[1]).sort();
      const out = spawnSync('bash', ['-c', `${fn}\nrpc_args ${f}`], { encoding: 'utf-8' }).stdout;
      expect({ f, keys: Object.keys(JSON.parse(out)).sort() }).toEqual({ f, keys: want });
    }
  });

  test('verify.sh sends a test event the ingest accepts', () => {
    const line = VERIFY.split('\n').find(l => l.startsWith('PROBE='))!;
    const out = spawnSync('bash', ['-c', `${line}\nprintf %s "$PROBE"`], { encoding: 'utf-8' }).stdout;
    expect(toRow(JSON.parse(out))).toMatchObject({ source: 'test', event_type: 'setup' });
  });

  // Value: protects=verify.sh never puts the publishable key or a signed-in user's JWT on a command line, and a run that skipped the signed-in checks never exits 0; fails_when=a curl line carries a key or JWT again, the header files stop reaching the server, or INCOMPLETE exits 0; why_new=the other verify.sh tests are static; seam=a local HTTP stand-in for the project; no_claim=a live Supabase answer
  test('verify.sh sends its keys from files and fails an incomplete run', async () => {
    for (const l of VERIFY.split('\n').filter(l => l.includes('curl '))) expect(l).not.toMatch(/\$(KEY|JWT|bearer)\b/);
    const seen: string[] = [];
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${req.headers.get('apikey')}|${req.headers.get('authorization') ?? ''}`);
      if (path.endsWith('gbrain-telemetry-ingest')) return Response.json({ accepted: 1, rejected: 0 });
      if (path.endsWith('gbrain-telemetry-pulse')) return Response.json({ status: 'ok' });
      return Response.json({ code: '42501' }, { status: 401 });
    } });
    const run = async (jwt?: string) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? '', GBRAIN_TELEMETRY_URL: `http://127.0.0.1:${server.port}`, GBRAIN_TELEMETRY_KEY: 'pk-example' };
      if (jwt) env.GBRAIN_VERIFY_AUTH_JWT = jwt;
      const proc = Bun.spawn(['bash', join(DIR, 'verify.sh')], { env, stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text();
      return { code: await proc.exited, out };
    };
    try {
      const partial = await run();
      expect(partial.out).not.toContain('FAIL');
      expect(partial.out).toContain('VERDICT: INCOMPLETE');
      expect(partial.code).toBe(2);
      expect(seen).toContain('pk-example|Bearer pk-example');
      seen.length = 0;
      const full = await run('jwt-example');
      expect(full.out).toContain('VERDICT: PASS');
      expect(full.code).toBe(0);
      expect(seen).toContain('pk-example|Bearer jwt-example');
    } finally {
      server.stop(true);
    }
  });

  test('only a live event records an installation, so verify.sh and test probes never do', () => {
    expect(INGEST).toMatch(/typeof r\.installation_id === "string" && r\.source === "live"/);
  });

  test('the ingest writes with the service-role key and never the caller\'s', () => {
    expect(INGEST).toContain('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
    expect(INGEST).not.toMatch(/req\.headers\.get\("(authorization|apikey)"\)/i);
  });

  test('forget never touches the daily ceiling, so load can never block withdrawal', () => {
    const start = INGEST.indexOf('"forget" in body');
    const forget = INGEST.slice(start, INGEST.indexOf('const events =', start));
    expect(forget).toContain('gbrain_telemetry_forget');
    expect(forget).not.toContain('gbrain_ingest_reserve');
    expect(forget).not.toContain('daily_ceiling');
    expect(start).toBeLessThan(INGEST.indexOf('gbrain_ingest_reserve'));
  });
});

describe('gbrain telemetry ingest: field checks (validate.ts)', () => {
  const now = new Date().toISOString();
  const base = { v: 1, ts: now, event_type: 'setup', gbrain_version: '0.60.760.0', tier: 'anonymous', os: 'linux', arch: 'x64' };

  test('a valid event keeps its fields and lands on the hour', () => {
    const row = toRow({ ...base, harness: 'hermes', step: 'mcp_register', outcome: 'error', error_code: 'mcp_register_failed', duration_s: 12 })!;
    expect(row).toMatchObject({ event_type: 'setup', harness: 'hermes', step: 'mcp_register', outcome: 'error', error_code: 'mcp_register_failed', duration_s: 12 });
    expect(new Date(row.event_hour as string).getUTCMinutes()).toBe(0);
    expect(new Date(row.event_hour as string).getUTCSeconds()).toBe(0);
  });

  test('keys the ingest does not know never reach the row', () => {
    const row = toRow({ ...base, slug: 'people/alice-example', query: 'who is alice', path: '/home/x/brain', hostname: 'box-1' })!;
    for (const k of ['slug', 'query', 'path', 'hostname']) expect(k in row).toBe(false);
    expect(JSON.stringify(row)).not.toMatch(/alice|\/home|box-1/);
  });

  test('off-list and off-shape values become null, unknown or other, never free text', () => {
    const row = toRow({ ...base, harness: 'my-private-harness', os: 'plan9', install_method: 'curl', error_code: 'people/alice example',
      failing_checks: ['dangling_aliases', 'source alice', 7], command_counts: { query: 3, 'people/alice': 9, doctor: -1 },
      crash_counts: { TypeError: 1, AliceError: 2 }, duration_s: 99_999_999 })!;
    expect(row.harness).toBeNull();
    expect(row.os).toBe('other');
    expect(row.install_method).toBe('unknown');
    expect(row.error_code).toBeNull();
    expect(row.failing_checks).toEqual(['dangling_aliases']);
    expect(row.command_counts).toEqual({ query: 3 });
    expect(row.crash_counts).toEqual({ TypeError: 1 });
    expect(row.duration_s).toBeNull();
  });

  test('an installation id survives only at the community tier', () => {
    const id = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    expect(toRow({ ...base, installation_id: id })!.installation_id).toBeNull();
    expect(toRow({ ...base, tier: 'community', installation_id: id })!.installation_id).toBe(id);
    expect(toRow({ ...base, tier: 'community', installation_id: 'my-laptop' })!.installation_id).toBeNull();
  });

  test('a wrong schema version, a missing required field or a time far off is refused whole', () => {
    expect(toRow({ ...base, v: 2 })).toBeNull();
    expect(toRow({ ...base, gbrain_version: 'latest' })).toBeNull();
    expect(toRow({ ...base, tier: 'off' })).toBeNull();
    expect(toRow({ ...base, event_type: 'page_read' })).toBeNull();
    expect(toRow({ ...base, gbrain_version: '00.60.760.0' })).toBeNull();
    expect(toRow({ ...base, gbrain_version: '0.060.760.0' })).toBeNull();
    expect(toRow({ ...base, gbrain_version: '0.60.0.0' })!.gbrain_version).toBe('0.60.0.0');
    expect(toRow({ ...base, event_type: 'upgrade', from_version: '0.60.07.0' })!.from_version).toBeNull();
    expect(toRow({ ...base, ts: new Date(Date.now() + 3 * 3_600_000).toISOString() })).toBeNull();
    expect(toRow({ ...base, ts: new Date(Date.now() - 40 * 86_400_000).toISOString() })).toBeNull();
  });
});

describe('gbrain telemetry ingest: days and counts', () => {
  const base = { v: 1, ts: new Date().toISOString(), event_type: 'daily_rollup', gbrain_version: '0.60.760.0', tier: 'anonymous', os: 'linux', arch: 'x64' };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  test('a rollup day must be a real calendar day from the last month', () => {
    expect(toRow({ ...base, rollup_day: daysAgo(1) })!.rollup_day).toBe(daysAgo(1));
    for (const d of ['2026-02-30', '2026-13-45', '2026-00-10', daysAgo(40), daysAgo(-3), '20261122']) {
      expect({ d, kept: toRow({ ...base, rollup_day: d })!.rollup_day }).toEqual({ d, kept: null });
    }
  });

  test('a count above 10,000 for one key is capped at 10,000', () => {
    const row = toRow({ ...base, command_counts: { query: 10_000, doctor: 10_001 }, error_code_counts: { no_brain: 1_000_000 } })!;
    expect(row.command_counts).toEqual({ query: 10_000, doctor: 10_000 });
    expect(row.error_code_counts).toEqual({ no_brain: 10_000 });
  });
});
