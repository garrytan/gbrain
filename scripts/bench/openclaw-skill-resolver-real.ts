#!/usr/bin/env bun
/**
 * The skill-resolver plugin in a REAL OpenClaw gateway, on a labelled request
 * set. A bench, not a test: it reports numbers and gates nothing.
 *
 *   bun scripts/bench/openclaw-skill-resolver-real.ts [--openclaw <bin>] [--data <dir>] [--size 750]
 *       [--limit N] [--load N] [--top-gate G] [--out summary.json]   (--out also writes <name>.turns.jsonl, one row per turn)
 *
 * Data: the public labelled set from gbrain-evals' offline skill-ranker eval
 * (docs/benchmarks/2026-11-07-skill-ranker-offline/data at EVALS_COMMIT): the
 * first --size skills of catalog.jsonl.gz (the eval's own cut; every skill is
 * from a public repository, licences in that directory) and the frozen test
 * plus stress-test turns (320), each labelled with the skills that are
 * acceptable for it, or none. Without --data it downloads those files.
 *
 * Each turn is one real `openclaw agent` turn in a fresh session through a
 * running gateway, with the plugin live and a loopback fake model (no key,
 * no paid call). OpenClaw's per-source load limit is raised to 1000, so the
 * gateway lists the whole catalog. It reports, per turn class:
 *   - right_skill_in_block: share of turns with an acceptable skill in the
 *     catalog whose <relevant_skills> block holds at least one of them (and
 *     best_in_block for the single best label, when it is in the catalog);
 *     turns whose acceptable skills all fall outside the --size cut are
 *     counted as out_of_catalog and left out of both rates;
 *   - false_suggestion: share of turns labelled with no acceptable skill at
 *     all that got a block;
 *   - deadline_miss: share of turns the plugin logged as timeout;
 *   - the plugin's own ms per turn (p50, p95) from its log line, and the whole
 *     turn's wall time (p95).
 * --load N runs N busy-loop processes for the whole run (a loaded machine).
 * --top-gate G sets skills.resolver.per_harness.openclaw.top_gate before setup
 * (0 turns the no-skill gate off); without it the resolver's default applies.
 * The summary names the OpenClaw version, gbrain commit, CPU count, catalog,
 * request set and load beside every number.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { REPO, RealOpenclaw, blockIds, openclawBin, promptText } from '../../test/helpers/openclaw-real-gateway.ts';

const EVALS_COMMIT = '20f30c00b151d4c40aca3e78ec9c763578aa88fe';
const EVALS_DIR = 'docs/benchmarks/2026-11-07-skill-ranker-offline/data';
const FILES = ['catalog.jsonl.gz', 'test.jsonl', 'stress-test.jsonl'];

const args = process.argv.slice(2);
const opt = (f: string, d = '') => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
const size = Number(opt('--size', '750'));
const limit = Number(opt('--limit', '0'));
const load = Number(opt('--load', '0'));
const topGate = opt('--top-gate');
const out = opt('--out');
const bin = opt('--openclaw') || openclawBin();
if (!bin) { console.error('no OpenClaw CLI: pass --openclaw <bin> or put openclaw on PATH'); process.exit(2); }

let data = opt('--data');
if (!data) {
  data = join(tmpdir(), 'gbrain-skill-ranker-data-' + EVALS_COMMIT.slice(0, 12));
  mkdirSync(data, { recursive: true });
  for (const f of FILES) {
    if (existsSync(join(data, f))) continue;
    const r = await fetch('https://raw.githubusercontent.com/garrytan/gbrain-evals/' + EVALS_COMMIT + '/' + EVALS_DIR + '/' + f);
    if (!r.ok) { console.error('download failed: ' + f + ' ' + r.status); process.exit(2); }
    writeFileSync(join(data, f), Buffer.from(await r.arrayBuffer()));
  }
}

interface Skill { id: string; description: string; body?: string }
interface Turn { id: string; intent: string; text: string; acceptable: string[]; best: string | null }
const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const catalog = gunzipSync(readFileSync(join(data, 'catalog.jsonl.gz'))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Skill).slice(0, size);
const inCatalog = new Set(catalog.map((s) => s.id));
const turns = ['test.jsonl', 'stress-test.jsonl'].flatMap((f) => readFileSync(join(data!, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Turn));
const run = limit > 0 ? turns.slice(0, limit) : turns;

const p = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!; };
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : null);

const burners: Array<ReturnType<typeof Bun.spawn>> = [];
let oc: RealOpenclaw | undefined;
const stop = async () => { for (const b of burners) b.kill(); await oc?.close(); };
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void stop().finally(() => process.exit(130)); });
try {
  for (let i = 0; i < load; i++) burners.push(Bun.spawn([process.execPath, '-e', 'for (;;) {}'], { stdout: 'ignore', stderr: 'ignore' }));
  oc = new RealOpenclaw(bin, 'bench');
  const seen = new Set<string>();
  for (const s of catalog) {
    const name = slug(s.id);
    if (seen.has(name)) throw new Error('two catalog ids share the name ' + name);
    seen.add(name);
    oc.skill(name, s.description.replace(/\s+/g, ' ').slice(0, 1000));
  }
  await oc.start();
  for (const [k, v] of [['skills.limits.maxSkillsLoadedPerSource', '1000'], ['skills.limits.maxCandidatesPerRoot', '1000']]) {
    if ((await oc.openclaw(['config', 'set', k!, v!])).code !== 0) throw new Error('openclaw config set ' + k + ' failed');
  }
  const version = (await oc.openclaw(['--version'])).stdout.trim().split('\n').at(-1) ?? '';
  if ((await oc.gbrain(['init', '--pglite', '--no-embedding'])).code !== 0) throw new Error('gbrain init failed');
  if (topGate && (await oc.gbrain(['config', 'set', 'skills.resolver.per_harness.openclaw.top_gate', topGate])).code !== 0) throw new Error('gbrain config set top_gate failed');
  const setup = await oc.gbrain(['setup', 'openclaw', '--skill-loading', 'resolve', '--agent', 'main', '--gbrain-bin', oc.gbrainBin, '--json']);
  if (setup.code !== 0) throw new Error('gbrain setup openclaw failed:\n' + setup.stderr.slice(-3000));
  const listed = JSON.parse(setup.stdout).skill_resolver.agents?.[0]?.skills;
  if (listed !== catalog.length) console.error('[bench] warning: setup listed ' + listed + ' of ' + catalog.length + ' catalog skills');
  await oc.startGateway();

  const rows: Array<{ id: string; intent: string; label: 'skill' | 'none' | 'out_of_catalog'; suggested: string[]; hit: boolean; best_hit: boolean | null; shown: boolean; outcome: string; plugin_ms: number | null; wall_ms: number }> = [];
  for (const [i, t] of run.entries()) {
    const before = oc.logLines().length;
    const r = await oc.turn('bench-' + i, t.text);
    if (r.ran.code !== 0) throw new Error('turn ' + t.id + ' failed:\n' + r.ran.stderr.slice(-2000));
    const lines = await oc.waitForLog(before + 1);
    const line = lines.slice(before).find((l) => l.agent === 'main' && l.outcome !== 'read') ?? {};
    const ids = r.requests.length ? blockIds(promptText(r.requests[0]!, t.text), 'relevant_skills') ?? [] : [];
    const acceptable = t.acceptable.filter((a) => inCatalog.has(a)).map(slug);
    rows.push({
      id: t.id, intent: t.intent, label: t.acceptable.length === 0 ? 'none' : acceptable.length ? 'skill' : 'out_of_catalog', suggested: ids,
      hit: ids.some((x) => acceptable.includes(x)), best_hit: t.best !== null && inCatalog.has(t.best) ? ids.includes(slug(t.best)) : null,
      shown: ids.length > 0, outcome: String(line.outcome ?? 'none'), plugin_ms: typeof line.ms === 'number' ? line.ms : null, wall_ms: r.ran.ms,
    });
    if ((i + 1) % 20 === 0) console.error('[bench] ' + (i + 1) + '/' + run.length);
  }

  const summarize = (rs: typeof rows) => {
    const labelled = rs.filter((r) => r.label === 'skill');
    const none = rs.filter((r) => r.label === 'none');
    const best = labelled.filter((r) => r.best_hit !== null);
    const ms = rs.map((r) => r.plugin_ms).filter((x): x is number => x !== null);
    return {
      turns: rs.length, labelled_turns: labelled.length, no_skill_turns: none.length, out_of_catalog_turns: rs.length - labelled.length - none.length,
      right_skill_in_block: rate(labelled.filter((r) => r.hit).length, labelled.length),
      best_in_block: rate(best.filter((r) => r.best_hit).length, best.length),
      false_suggestion: rate(none.filter((r) => r.shown).length, none.length),
      deadline_miss: rate(rs.filter((r) => r.outcome === 'timeout').length, rs.length),
      plugin_ms_p50: p(ms, 0.5), plugin_ms_p95: p(ms, 0.95), turn_wall_ms_p95: p(rs.map((r) => r.wall_ms), 0.95),
      outcomes: Object.fromEntries([...new Set(rs.map((r) => r.outcome))].map((o) => [o, rs.filter((r) => r.outcome === o).length])),
    };
  };
  const gitHead = Bun.spawnSync(['git', '-C', REPO, 'rev-parse', 'HEAD']).stdout.toString().trim();
  const summary = {
    openclaw: version, gbrain_commit: gitHead, cpus: cpus().length, load_processes: load, top_gate: topGate ? Number(topGate) : 'resolver default',
    catalog: { source: 'garrytan/gbrain-evals@' + EVALS_COMMIT + ' ' + EVALS_DIR + '/catalog.jsonl.gz', skills: catalog.length, listed_by_setup: listed, all_listed: listed === catalog.length },
    requests: { source: 'test.jsonl + stress-test.jsonl (frozen labelled split)', turns: run.length },
    all: summarize(rows),
    by_intent: Object.fromEntries([...new Set(rows.map((r) => r.intent))].map((k) => [k, summarize(rows.filter((r) => r.intent === k))])),
  };
  const text = JSON.stringify(summary, null, 2);
  if (out) {
    writeFileSync(out, text + '\n');
    writeFileSync(out.replace(/\.json$/, '') + '.turns.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  console.log(text);
} finally {
  await stop();
}
