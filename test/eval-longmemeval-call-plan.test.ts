/**
 * `gbrain eval longmemeval --call-plan FILE` writes gstack's eval call plan
 * (GSTACK_EVAL_CALLS v1) for the run its flags describe, with no provider
 * call and no brain.
 *
 * Protects: every run seam throws and none is reached (no client, embed,
 * readiness probe or benchmark brain); the file passes a local
 * re-implementation of the gstack v1 grammar checks; flags turn lanes on and
 * off; `--expansion-replay` turns expansion off and sets the query-embed
 * count from its file; the GATE line round-trips argv quoting and
 * `--call-plan-gate` replaces it; the tracked fixture binds as an INPUT line;
 * lanes the planner cannot bound refuse and write nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { enableDecideEvalOverride } from '../src/core/ai/decide/config.ts';
import { countCJKAwareWords } from '../src/core/cjk.ts';
import { CALL_PLAN_CHARS_PER_TOKEN, gateCommand, shellQuote } from '../src/eval/longmemeval/call-plan.ts';
import { withEnv } from './helpers/with-env.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');
const QUESTIONS = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as { question_id: string; question: string });
const tmp = mkdtempSync(join(tmpdir(), 'lme-call-plan-'));
const GATEWAY = { embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024, expansion_model: 'anthropic:claude-haiku-4-5-20251001', env: {} };

const KEYS = ['purpose', 'model', 'calls', 'in_tokens', 'out_tokens', 'max_out_tokens', 'scope'];
type Row = Record<string, string>;

/** Local re-implementation of gstack's v1 parse checks (docs/eval-calls.md): kinds, keys, counts, end line, nothing after it. */
function parseGstackV1(text: string): { gate: string; head: string; inputs: string[]; preconditions: string[]; rows: Row[] } {
  let gate: string | null = null;
  let head: string | null = null;
  let endAt = -1;
  const inputs: string[] = [];
  const preconditions: string[] = [];
  const rows: Row[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, n) => {
    const fail = (why: string): never => { throw new Error(`EVAL_DRY_RUN_FAILED line ${n + 1}: ${why}: ${line}`); };
    if (endAt >= 0 && line.trim() !== '') fail('content after the end line');
    if (line.trim() === '' || line.startsWith('#')) return;
    let m: RegExpExecArray | null;
    if ((m = /^GSTACK_EVAL_GATE v1: (.+)$/.exec(line))) { if (gate !== null) fail('second GATE'); gate = m[1]!; return; }
    if ((m = /^GSTACK_EVAL_HEAD v1: ([0-9a-f]{40})$/.exec(line))) { if (head !== null) fail('second HEAD'); head = m[1]!; return; }
    if ((m = /^GSTACK_EVAL_INPUT v1: sha256=([0-9a-f]{64}) path=(\S+)$/.exec(line))) {
      if (m[2]!.startsWith('/') || m[2]!.split('/').includes('..')) fail('input path not repo-relative');
      inputs.push(m[2]!); return;
    }
    if ((m = /^GSTACK_EVAL_PRECONDITION: (.+)$/.exec(line))) { preconditions.push(m[1]!); return; }
    if ((m = /^GSTACK_EVAL_CALLS v1 end: lines=(\d+)$/.exec(line))) {
      if (Number(m[1]) !== rows.length) fail(`end line counts ${m[1]}, file has ${rows.length}`);
      endAt = n; return;
    }
    if ((m = /^GSTACK_EVAL_CALLS v1: (.+)$/.exec(line))) {
      const row: Row = {};
      for (const tok of m[1]!.split(' ')) {
        const eq = tok.indexOf('=');
        const k = tok.slice(0, eq);
        if (eq <= 0 || !KEYS.includes(k)) fail(`unknown key ${tok}`);
        if (k in row) fail(`duplicate key ${k}`);
        row[k] = tok.slice(eq + 1);
      }
      if (Object.keys(row).length !== KEYS.length) fail('missing key');
      if (!/^[A-Za-z0-9._:-]+$/.test(row.purpose!)) fail('bad purpose');
      for (const k of ['calls', 'in_tokens', 'out_tokens', 'max_out_tokens']) if (!/^\d+$/.test(row[k]!)) fail(`non-integer ${k}`);
      if (Number(row.calls) < 1) fail('calls=0');
      if (row.scope !== 'full' && row.scope !== 'smoke') fail('bad scope');
      const id = `${row.purpose}\u0000${row.model}`;
      if (seen.has(id)) fail('duplicate purpose+model');
      seen.add(id);
      rows.push(row);
      return;
    }
    fail('unknown line kind');
  });
  if (gate === null || head === null || endAt < 0) throw new Error('EVAL_DRY_RUN_FAILED: missing GATE, HEAD or end line');
  return { gate, head, inputs, preconditions, rows };
}

/** POSIX shell word splitting (single quotes, backslash escapes, whitespace). */
function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") { const j = s.indexOf("'", i + 1); cur = (cur ?? '') + s.slice(i + 1, j); i = j; continue; }
    if (c === '\\') { cur = (cur ?? '') + s[++i]; continue; }
    if (/\s/.test(c)) { if (cur !== null) words.push(cur); cur = null; continue; }
    cur = (cur ?? '') + c;
  }
  if (cur !== null) words.push(cur);
  return words;
}

const called: string[] = [];
const boom = (name: string): never => { called.push(name); throw new Error(`${name} must not be called by --call-plan`); };
const THROWING_SEAMS = {
  exitOnError: false,
  client: { create: async () => boom('reader client') },
  extractorClient: { create: async () => boom('extractor client') },
  judgeClient: async () => boom('judge client'),
  expandFn: async () => boom('expandFn'),
  embedTransport: (async () => boom('embed transport')) as never,
  rerankerReadiness: async () => boom('reranker readiness'),
  createBrain: async () => boom('createBrain (benchmark brain)'),
} as unknown as Parameters<typeof runEvalLongMemEval>[1];

async function plan(args: string[]): Promise<{ text: string; parsed: ReturnType<typeof parseGstackV1>; rows: Record<string, Row>; err: string; path: string }> {
  const path = join(tmp, `plan-${Math.random().toString(36).slice(2)}.calls`);
  const write = process.stderr.write.bind(process.stderr);
  let err = '';
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    await runEvalLongMemEval([FIXTURE, ...args, '--call-plan', path], THROWING_SEAMS);
  } catch (e) {
    throw Object.assign(e as Error, { message: `${(e as Error).message}\n${err}` });
  } finally {
    process.stderr.write = write;
  }
  expect(called).toEqual([]);
  expect(existsSync(`${path}.tmp`)).toBe(false);
  const text = readFileSync(path, 'utf8');
  const parsed = parseGstackV1(text);
  return { text, parsed, rows: Object.fromEntries(parsed.rows.map(r => [r.purpose, r])), err, path };
}

async function refusal(args: string[]): Promise<string> {
  const path = join(tmp, `refused-${Math.random().toString(36).slice(2)}.calls`);
  const write = process.stderr.write.bind(process.stderr);
  let err = '';
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    await expect(runEvalLongMemEval([FIXTURE, ...args, '--call-plan', path], THROWING_SEAMS)).rejects.toThrow(/longmemeval failed \(exit 1\)/);
  } finally {
    process.stderr.write = write;
  }
  expect(called).toEqual([]);
  expect(existsSync(path)).toBe(false);
  expect(existsSync(`${path}.tmp`)).toBe(false);
  return err;
}

const purposes = (r: Record<string, Row>) => Object.keys(r).sort();

beforeAll(() => { configureGateway(GATEWAY); });
afterAll(() => {
  resetGateway();
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval longmemeval --call-plan', () => {
  test('writes a gstack v1 plan with no provider call and no brain; the tracked fixture binds as INPUT', async () => {
    const p = await plan(['--mode', 'tokenmax', '--judge', '--expansion', '--fact-keys', 'chunk']);
    expect(purposes(p.rows)).toEqual(['embed_doc', 'embed_query', 'expansion', 'fact_keys', 'judge', 'reader', 'rerank', 'synopsis', 'trajectory_extract']);
    expect(p.parsed.inputs).toEqual(['test/fixtures/longmemeval-mini.jsonl']);
    expect(p.parsed.head).toMatch(/^[0-9a-f]{40}$/);
    expect(p.parsed.preconditions.some(t => t.includes(`ceil(chars / ${CALL_PLAN_CHARS_PER_TOKEN})`))).toBe(true);
    expect(p.parsed.preconditions.some(t => t.includes('uncached worst case') && t.includes('retries'))).toBe(true);
    for (const r of p.parsed.rows) {
      expect(Number(r.out_tokens)).toBe(Number(r.calls) * Number(r.max_out_tokens));
      expect(r.scope).toBe('full');
      expect(r.model).toMatch(/^[a-z-]+:/);
    }
    expect(p.rows.reader).toMatchObject({ calls: String(QUESTIONS.length), max_out_tokens: '1024', model: 'anthropic:claude-sonnet-4-6' });
    expect(p.rows.judge).toMatchObject({ calls: String(QUESTIONS.length), max_out_tokens: '16', model: 'openai:gpt-4o' });
    expect(p.rows.expansion).toMatchObject({ model: 'anthropic:claude-haiku-4-5-20251001', max_out_tokens: '64000' });
    expect(p.rows.synopsis!.max_out_tokens).toBe('200');
    expect(p.rows.trajectory_extract!.max_out_tokens).toBe('2000');
    expect(p.rows.rerank).toMatchObject({ model: 'voyage:rerank-3-lite', calls: String(QUESTIONS.length), max_out_tokens: '0' });
    expect(p.text.endsWith(`GSTACK_EVAL_CALLS v1 end: lines=${p.parsed.rows.length}\n`)).toBe(true);
    expect(p.err).toContain('no provider was called');
  }, 60_000);

  test('flags turn lanes on and off', async () => {
    const base = await plan([]);
    expect(purposes(base.rows)).toEqual(['embed_doc', 'embed_query', 'reader', 'rerank', 'trajectory_extract']);
    expect(purposes((await plan(['--no-trajectory'])).rows)).toEqual(['embed_doc', 'embed_query', 'reader', 'rerank']);
    expect(purposes((await plan(['--keyword-only'])).rows)).toEqual(['reader', 'trajectory_extract']);
    expect(purposes((await plan(['--retrieval-only'])).rows)).toEqual(['embed_doc', 'embed_query', 'rerank', 'trajectory_extract']);
    expect(purposes((await plan(['--judge'])).rows)).toContain('judge');
    expect(purposes((await plan(['--mode', 'conservative'])).rows)).not.toContain('rerank');
    expect(purposes((await plan(['--reranker', 'off'])).rows)).not.toContain('rerank');
    const tm = await plan(['--mode', 'tokenmax']);
    expect(purposes(tm.rows)).toContain('synopsis');
    expect(Number(tm.rows.embed_doc!.calls)).toBeGreaterThan(Number(base.rows.embed_doc!.calls));
    expect(purposes((await plan(['--mode', 'tokenmax', '--keyword-only'])).rows)).not.toContain('synopsis');
    expect(purposes((await plan(['--fact-keys', 'page'])).rows)).toContain('fact_keys');
    expect(purposes((await plan(['--fact-keys', 'page', '--fact-extractor', 'production'])).rows)).toContain('fact_keys');
    expect(purposes((await plan(['--keyword-only', '--fact-keys', 'page'])).rows)).toEqual(['embed_doc', 'fact_keys', 'reader', 'trajectory_extract']);
    const none = await plan(['--keyword-only', '--retrieval-only', '--no-trajectory']);
    expect(none.parsed.rows).toEqual([]);
    expect(none.text).toContain('GSTACK_EVAL_CALLS v1 end: lines=0');
    const limited = await plan(['--limit', '2']);
    expect(limited.rows.reader!.calls).toBe('2');
  }, 120_000);

  test('--expansion calls once per question of 3+ words and embeds 3 variants; --expansion-replay drops the lane and counts the file', async () => {
    const expanding = QUESTIONS.filter(q => countCJKAwareWords(q.question) >= 3).length;
    const live = await plan(['--expansion']);
    expect(live.rows.expansion!.calls).toBe(String(expanding));
    expect(Number(live.rows.embed_query!.calls)).toBe(QUESTIONS.length + 2 * expanding);

    const replayFile = join(tmp, 'replay.jsonl');
    const recorded = { [QUESTIONS[0]!.question_id]: [QUESTIONS[0]!.question, 'alt one', 'alt two'], [QUESTIONS[1]!.question_id]: [QUESTIONS[1]!.question, 'alt one'] };
    writeFileSync(replayFile, Object.entries(recorded).map(([question_id, expansion_variants]) => JSON.stringify({ question_id, expansion_variants })).join('\n') + '\n');
    const replay = await plan(['--expansion-replay', replayFile]);
    expect(replay.rows.expansion).toBeUndefined();
    expect(replay.rows.embed_query!.calls).toBe(String(3 + 2 + (QUESTIONS.length - 2)));
    expect(replay.parsed.preconditions.some(t => t.startsWith('--expansion-replay file replay.jsonl sha256='))).toBe(true);
    expect(replay.parsed.preconditions.join('\n')).not.toContain(tmp);
  }, 60_000);

  test('the GATE line is the command minus --call-plan, quoted only where needed; --call-plan-gate replaces it', async () => {
    const out = join(tmp, 'a b', "it's.jsonl");
    const args = ['--limit', '2', '--output', out, '--search-pin', 'search.metadata_boost_gate=lexical', '--keyword-only'];
    const p = await plan(args);
    expect(shellWords(p.parsed.gate)).toEqual(['gbrain', 'eval', 'longmemeval', FIXTURE, ...args]);
    expect(p.parsed.gate).toContain('--limit 2 --output ');
    expect(gateCommand([FIXTURE, '--call-plan=x.calls', '--call-plan-gate', 'y', '--limit', '1'])).toBe(`gbrain eval longmemeval ${shellQuote(FIXTURE)} --limit 1`);
    expect(shellQuote('')).toBe("''");
    expect(shellWords(shellQuote(`a'b "c" $d`))).toEqual([`a'b "c" $d`]);
    const custom = await plan(['--keyword-only', '--call-plan-gate', 'bun run eval:lme --questions 5']);
    expect(custom.parsed.gate).toBe('bun run eval:lme --questions 5');
  }, 60_000);

  test('lanes it cannot bound refuse with nothing written', async () => {
    expect(await refusal(['--via-operation', 'query'])).toContain('cannot bound --via-operation');
    try {
      expect(await withEnv({ GBRAIN_DECIDE_SLOTS: undefined }, () => refusal(['--decide', 'intent=on', '--no-trajectory']))).toContain('cannot bound the decide lane');
    } finally {
      enableDecideEvalOverride(false);
    }
    expect(await refusal(['--search-pin', 'search.cross_modal.llm_intent=true'])).toContain('llm_intent');
    configureGateway({ ...GATEWAY, expansion_model: 'openai:gpt-5.6' });
    try {
      expect(await refusal(['--expansion'])).toContain('cannot bound expansion on openai:gpt-5.6');
    } finally {
      configureGateway(GATEWAY);
    }
    await expect(runEvalLongMemEval([FIXTURE, '--call-plan-gate', 'x'], THROWING_SEAMS)).rejects.toThrow(/exit 1/);
  }, 60_000);
});
