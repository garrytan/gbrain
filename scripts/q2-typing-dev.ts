#!/usr/bin/env bun
/**
 * Q2 typing units: development dumps and identity tables (development data only).
 *
 *   bun scripts/q2-typing-dev.ts dump --evals <gbrain-evals checkout> --root <gbrain tree> \
 *     --phrasing A|A2|A3|<dev phrasing JSON> [--seeds 3,5] [--units U1,U3|none] --out <dump.json>
 *   bun scripts/q2-typing-dev.ts compare --base <dump.json> --arm <dump.json> [--json]
 *   bun scripts/q2-typing-dev.ts world-v1 --evals <gbrain-evals checkout> --root <gbrain tree> [--units U1,U3|none] [--out <edges.json>]
 *
 * `dump` renders the temporal-edges world (gbrain-evals eval/generators/temporal-edges-gen.ts, E5 probe people
 * included) for each development seed, writes every page through `put_page` on in-memory PGLite using the gbrain
 * tree at `--root` (a checkout, a worktree or a gbrain-evals overlay), and records per person page: the derived link
 * rows (type, source, tense, context), the link_transitions rows, and what a default `get_links` returns.
 * `--units` (only for a tree that has src/core/link-typing-units.ts) runs with that typing-unit set instead of
 * ENABLED_TYPING_UNITS.
 *
 * `compare` prints the type-steal and transition tables by identity (subject, target, type, kind, date) against the
 * generator ledger: edges that lost a ledger type or gained more unsupported types than they shed (steals), edges that
 * gained a ledger type (gains), new wrong transitions, fixed and missing
 * correct transitions, and current employers lost from or added to the live read.
 *
 * `world-v1` types gbrain-evals' world-v1 corpus (eval/data/world-v1, rendered as the P5 H1 runner renders it) with
 * extractPageLinks and deriveTemporalEvidence of the tree at `--root` and prints the SHA-256 of the sorted edge and
 * transition lines; two trees (or unit sets) type the corpus identically exactly when the digests match.
 *
 * Hermetic: provider keys are removed from the environment and GBRAIN_HOME is a fresh temp dir; zero LLM calls.
 * Held-out (custody) phrasing files are refused: the phrasing JSON must live inside this repository's
 * test/fixtures/q2-dev-phrasings/.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Row = Record<string, unknown>;

interface Ledger {
  slug: string;
  stints: Array<{ company: string; from: string; until: string | null; role: string }>;
  advises: { company: string; from: string } | null;
  invests_after_exit: { company: string; on: string } | null;
  alumni_meeting: { company: string; on: string } | null;
  e5?: { advisory_target: string; advisory_on: string; form: string; target: string };
}

export interface PersonDump {
  seed: number;
  slug: string;
  ledger: Ledger;
  links: Array<{ to: string; type: string; source: string | null; tense: string | null; context: string }>;
  transitions: Array<{ from: string; to: string; type: string; kind: string; on: string; producer: string }>;
  live: Array<{ to: string; type: string }>;
}

export interface Dump { root: string; units: string[] | null; phrasing: string; seeds: number[]; people: PersonDump[] }

function arg(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

function fail(what: string, why: string, next: string): never {
  console.error(`${what}\nWhy: ${why}\nNext: ${next}`);
  process.exit(2);
}

function hermetic(): void {
  for (const k of Object.keys(process.env)) if (/(_API_KEY|_API_TOKEN|_BEARER_TOKEN)$|^(TYPESAFE|JEV)_/.test(k)) delete process.env[k];
  process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'q2-typing-dev-'));
}

async function dump(argv: readonly string[]): Promise<void> {
  const evals = arg(argv, '--evals');
  const root = arg(argv, '--root');
  const out = arg(argv, '--out');
  const phrasingArg = arg(argv, '--phrasing') ?? 'A';
  if (!evals || !root || !out) fail('dump needs --evals, --root and --out.', 'the world comes from gbrain-evals and the build under test from --root.', 'bun scripts/q2-typing-dev.ts dump --evals ../gbrain-evals --root . --phrasing A --out /tmp/a.json');
  const seeds = (arg(argv, '--seeds') ?? '3,5').split(',').map(Number);
  if (!seeds.every(s => [3, 5].includes(s))) fail(`seeds ${seeds.join(',')} refused.`, 'only the temporal-edges development seeds 3 and 5 run here; held-out seeds belong to the custodian.', 'pass --seeds 3,5');
  hermetic();
  const gen = await import(join(resolve(evals!), 'eval/generators/temporal-edges-gen.ts'));
  let phrasing: Record<string, unknown>;
  if (['A', 'A2', 'A3'].includes(phrasingArg)) phrasing = { phrasing: phrasingArg };
  else {
    const file = resolve(phrasingArg);
    if (!file.startsWith(resolve(import.meta.dir, '../test/fixtures/q2-dev-phrasings/'))) {
      fail(`phrasing file ${phrasingArg} refused.`, 'only development phrasings under test/fixtures/q2-dev-phrasings/ run here; custody files never enter this tree.', 'pass A, A2, A3 or a file from test/fixtures/q2-dev-phrasings/');
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { id: string; templates: unknown };
    phrasing = { sealedPhrasing: { id: `dev:${parsed.id}`, templates: gen.validatePhrasing(parsed.templates) } };
  }
  const rootAbs = resolve(root!);
  const unitsArg = arg(argv, '--units');
  let units: string[] | null = null;
  if (unitsArg !== undefined) {
    const mod = await import(join(rootAbs, 'src/core/link-typing-units.ts')).catch(() => null);
    if (!mod) fail(`--units refused for ${rootAbs}.`, 'that tree has no src/core/link-typing-units.ts.', 'drop --units, or point --root at a tree with the typing units');
    units = unitsArg === 'none' ? [] : unitsArg.split(',').map(s => s.trim()).filter(Boolean);
    mod.setTypingUnitsForTests(units);
  }
  const { PGLiteEngine } = await import(join(rootAbs, 'src/core/pglite-engine.ts'));
  const { operations } = await import(join(rootAbs, 'src/core/operations.ts'));
  const byName = new Map((operations as Array<{ name: string; handler: (ctx: unknown, p: Row) => Promise<unknown> }>).map(o => [o.name, o]));
  const people: PersonDump[] = [];
  for (const seed of seeds) {
    const world = gen.generateTemporalEdgesWorld({ seed, e5Probe: true, ...phrasing });
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger, dryRun: false, remote: false, sourceId: 'default' };
    const op = (name: string, p: Row) => byName.get(name)!.handler(ctx, p);
    for (const page of world.pages as Array<{ slug: string; content: string }>) {
      const snap = await engine.readPageSnapshot(page.slug, { sourceId: 'default' });
      await op('put_page', { slug: page.slug, content: page.content, ...(snap ? { expected_revision: snap.revision } : {}) });
    }
    const ledgers: Ledger[] = [...world.people, ...(world.e5_probes ?? [])];
    for (const p of ledgers) {
      const links = await engine.executeRaw(
        `SELECT t.slug AS to, l.link_type AS type, l.link_source AS source, l.assertion_tense AS tense, l.context
           FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
          WHERE f.slug = $1 ORDER BY t.slug, l.link_type`, [p.slug]) as PersonDump['links'];
      const transitions = await engine.executeRaw(
        `SELECT f.slug AS from, t.slug AS to, lt.link_type AS type, lt.kind, lt.occurred_on::text AS on, lt.producer
           FROM link_transitions lt JOIN pages o ON o.id = lt.origin_page_id JOIN pages f ON f.id = lt.from_page_id JOIN pages t ON t.id = lt.to_page_id
          WHERE o.slug = $1 ORDER BY lt.occurred_on, t.slug, lt.kind`, [p.slug]) as PersonDump['transitions'];
      const live = ((await op('get_links', { slug: p.slug })) as Row[]).map(r => ({ to: String(r.to_slug), type: String(r.link_type) }));
      people.push({ seed, slug: p.slug, ledger: { slug: p.slug, stints: p.stints, advises: p.advises, invests_after_exit: p.invests_after_exit, alumni_meeting: p.alumni_meeting, ...(p.e5 ? { e5: p.e5 } : {}) }, links, transitions, live });
    }
    await engine.disconnect();
  }
  const result: Dump = { root: rootAbs, units, phrasing: phrasingArg, seeds, people };
  writeFileSync(out!, JSON.stringify(result));
  console.log(`dump: ${people.length} person pages, ${seeds.length} seed(s), units ${units ? units.join(',') || 'none' : 'build default'} -> ${out}`);
}

/** Gold relation types for a person -> target pair from the ledger alone (an E5 "other" target is also asserted as works_at). */
export function goldTypes(l: Ledger, target: string): Set<string> {
  const out = new Set<string>();
  if (l.stints.some(s => s.company === target) || (l.e5?.target === 'other' && l.e5.advisory_target === target)) out.add('works_at');
  if (l.advises?.company === target || l.e5?.advisory_target === target) out.add('advises');
  if (l.invests_after_exit?.company === target) out.add('invested_in');
  return out;
}

/** Gold transitions by identity (subject, target, type, kind, date). */
export function goldTransitions(l: Ledger): Set<string> {
  const out = new Set<string>();
  for (const s of l.stints) {
    out.add(tid(l.slug, s.company, 'works_at', 'start', s.from));
    if (s.until) out.add(tid(l.slug, s.company, 'works_at', 'end', s.until));
  }
  if (l.advises) out.add(tid(l.slug, l.advises.company, 'advises', 'start', l.advises.from));
  if (l.e5) out.add(tid(l.slug, l.e5.advisory_target, 'advises', 'start', l.e5.advisory_on));
  return out;
}

const tid = (subject: string, target: string, type: string, kind: string, on: string) => [subject, target, type, kind, on.slice(0, 10)].join(' | ');
const typesOf = (p: PersonDump, to: string) => new Set(p.links.filter(x => x.to === to && x.type !== 'mentions').map(x => x.type));
const show = (xs: Set<string>) => [...xs].sort().join('+') || 'mentions';
const role = (l: Ledger, to: string) => {
  const cur = l.stints.some(s => s.company === to && s.until === null);
  if (cur) return 'current employer';
  if (l.stints.some(s => s.company === to)) return 'former employer';
  if (l.advises?.company === to) return 'advisee';
  if (l.e5?.advisory_target === to) return 'e5 advisory target';
  return 'no ledger relation';
};

export function compareDumps(base: Dump, arm: Dump) {
  const key = (p: PersonDump) => `${p.seed}:${p.slug}`;
  const armBy = new Map(arm.people.map(p => [key(p), p]));
  const steals: Array<Row> = []; const gains: Array<Row> = []; const moves: Array<Row> = [];
  const newWrong: string[] = []; const removedWrong: string[] = []; const fixed: string[] = []; const missing: string[] = [];
  const liveLost: string[] = []; const liveGained: string[] = [];
  for (const b of base.people) {
    const a = armBy.get(key(b));
    if (!a) continue;
    const gold = goldTransitions(b.ledger);
    const ids = (p: PersonDump) => new Set(p.transitions.filter(t => t.from === p.slug).map(t => tid(t.from, t.to, t.type, t.kind, t.on)));
    const bt = ids(b); const at = ids(a);
    for (const t of at) if (!bt.has(t) && !gold.has(t)) newWrong.push(`s${b.seed} ${t}`);
    for (const t of at) if (!bt.has(t) && gold.has(t)) fixed.push(`s${b.seed} ${t}`);
    for (const t of bt) if (!at.has(t) && gold.has(t)) missing.push(`s${b.seed} ${t}`);
    for (const t of bt) if (!at.has(t) && !gold.has(t)) removedWrong.push(`s${b.seed} ${t}`);
    const targets = new Set([...b.links, ...a.links].map(x => x.to));
    for (const to of targets) {
      const tb = typesOf(b, to); const ta = typesOf(a, to);
      if (show(tb) === show(ta)) continue;
      const g = goldTypes(b.ledger, to);
      const lost = [...tb].filter(t => g.has(t) && !ta.has(t));
      const spurious = [...ta].filter(t => !g.has(t) && !tb.has(t));
      const won = [...ta].filter(t => g.has(t) && !tb.has(t));
      const dropped = [...tb].filter(t => !g.has(t) && !ta.has(t));
      const row = { seed: b.seed, subject: b.slug, target: to, ledger: role(b.ledger, to), gold: show(g), base: show(tb), arm: show(ta) };
      if (lost.length || spurious.length > dropped.length) steals.push(row);
      else if (won.length) gains.push(row);
      else moves.push(row);
    }
    const cur = new Set(b.ledger.stints.filter(s => s.until === null).map(s => s.company));
    const liveSet = (p: PersonDump) => new Set(p.live.filter(x => x.type === 'works_at').map(x => x.to));
    const lb = liveSet(b); const la = liveSet(a);
    for (const c of cur) {
      if (lb.has(c) && !la.has(c)) liveLost.push(`s${b.seed} ${b.slug} -> ${c}`);
      if (!lb.has(c) && la.has(c)) liveGained.push(`s${b.seed} ${b.slug} -> ${c}`);
    }
  }
  return { steals, gains, moves, newWrong, removedWrong, fixed, missing, liveLost, liveGained };
}

function printCompare(base: Dump, arm: Dump, json: boolean): void {
  const c = compareDumps(base, arm);
  if (json) { console.log(JSON.stringify(c, null, 2)); return; }
  const table = (rows: Row[]) => rows.length ? ['| seed | subject | target | ledger | gold | base | arm |', '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.seed} | ${r.subject} | ${r.target} | ${r.ledger} | ${r.gold} | ${r.base} | ${r.arm} |`)].join('\n') : '(none)';
  const list = (xs: string[]) => xs.length ? xs.map(x => `- ${x}`).join('\n') : '(none)';
  console.log(`base ${base.root} units ${base.units?.join(',') ?? 'default'}; arm ${arm.root} units ${arm.units?.join(',') ?? 'default'}; phrasing ${arm.phrasing}`);
  console.log(`steals ${c.steals.length}, gains ${c.gains.length}, other moves ${c.moves.length}, new wrong transitions ${c.newWrong.length}, wrong removed ${c.removedWrong.length}, fixed ${c.fixed.length}, missing correct ${c.missing.length}, live lost ${c.liveLost.length}, live gained ${c.liveGained.length}`);
  console.log(`\n### Type steals (base matched the ledger, arm does not)\n${table(c.steals)}`);
  console.log(`\n### Type gains\n${table(c.gains)}`);
  console.log(`\n### Other type moves\n${table(c.moves)}`);
  console.log(`\n### New wrong transitions\n${list(c.newWrong)}`);
  console.log(`\n### Wrong transitions removed\n${list(c.removedWrong)}`);
  console.log(`\n### Fixed transitions\n${list(c.fixed)}`);
  console.log(`\n### Missing correct transitions\n${list(c.missing)}`);
  console.log(`\n### Current employers lost from the live read\n${list(c.liveLost)}`);
  console.log(`\n### Current employers added to the live read\n${list(c.liveGained)}`);
}

interface WorldPage { slug: string; type: string; title: string; compiled_truth: string; timeline: string }

/** world-v1 pages as gbrain-evals' loadCorpus reads them (arrays joined, strings coerced). */
export function loadWorldV1(dir: string): WorldPage[] {
  return readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort().map(f => {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return {
      slug: String(p.slug), type: String(p.type), title: String(p.title ?? ''),
      compiled_truth: String(Array.isArray(p.compiled_truth) ? p.compiled_truth.join('\n\n') : p.compiled_truth ?? ''),
      timeline: String(Array.isArray(p.timeline) ? p.timeline.join('\n') : p.timeline ?? ''),
    };
  });
}

type ExtractFn = (slug: string, content: string, fm: Record<string, unknown>, pageType: string, resolver: unknown, opts?: Record<string, unknown>) => Promise<{ candidates: Array<{ targetSlug: string; linkType: string; linkSource?: string; fromSlug?: string }> }>;
type DeriveFn = (page: { slug: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }, rows: Array<Record<string, unknown>>) => { tense: Map<string, string>; transitions: Array<Record<string, unknown>> };

/** Sorted edge and transition lines for the corpus, and their SHA-256. */
export async function worldV1Edges(pages: readonly WorldPage[], extract: ExtractFn, derive: DeriveFn): Promise<{ lines: string[]; sha256: string }> {
  const slugs = new Set(pages.map(p => p.slug));
  const resolver = { resolve: async (name: string) => (slugs.has(name) ? name : null) };
  const lines: string[] = [];
  for (const p of pages) {
    const content = p.timeline ? `${p.compiled_truth}\n\n<!-- timeline -->\n\n${p.timeline}` : p.compiled_truth;
    const { candidates } = await extract(p.slug, content, { type: p.type, title: p.title }, p.type, resolver, {});
    const kept = candidates.filter(c => slugs.has(c.targetSlug));
    for (const c of kept) lines.push(JSON.stringify(['edge', c.fromSlug ?? p.slug, c.targetSlug, c.linkType, c.linkSource ?? 'markdown']));
    const rows = kept.map(c => ({ from_slug: c.fromSlug ?? p.slug, to_slug: c.targetSlug, link_type: c.linkType, link_source: c.linkSource ?? 'markdown' }));
    const ev = derive({ slug: p.slug, compiled_truth: p.compiled_truth, timeline: p.timeline, frontmatter: {} }, rows);
    for (const [k, v] of ev.tense) lines.push(JSON.stringify(['tense', p.slug, k.split('\0').join(' '), v]));
    for (const t of ev.transitions) lines.push(JSON.stringify(['transition', t.from_slug, t.to_slug, t.link_type, t.kind, t.occurred_on, t.producer]));
  }
  lines.sort();
  return { lines, sha256: createHash('sha256').update(lines.join('\n')).digest('hex') };
}

async function worldV1(argv: readonly string[]): Promise<void> {
  const evals = arg(argv, '--evals'); const root = arg(argv, '--root');
  if (!evals || !root) fail('world-v1 needs --evals and --root.', 'the corpus lives in gbrain-evals and the build under test is --root.', 'bun scripts/q2-typing-dev.ts world-v1 --evals ../gbrain-evals --root .');
  hermetic();
  const rootAbs = resolve(root!);
  const unitsArg = arg(argv, '--units');
  if (unitsArg !== undefined) {
    const mod = await import(join(rootAbs, 'src/core/link-typing-units.ts'));
    mod.setTypingUnitsForTests(unitsArg === 'none' ? [] : unitsArg.split(','));
  }
  const { extractPageLinks } = await import(join(rootAbs, 'src/core/link-extraction.ts'));
  const { deriveTemporalEvidence } = await import(join(rootAbs, 'src/core/link-temporal-evidence.ts'));
  const r = await worldV1Edges(loadWorldV1(join(resolve(evals!), 'eval/data/world-v1')), extractPageLinks, deriveTemporalEvidence);
  const out = arg(argv, '--out');
  if (out) writeFileSync(out, r.lines.join('\n') + '\n');
  console.log(`world-v1: ${r.lines.length} lines, sha256 ${r.sha256} (root ${rootAbs}, units ${unitsArg ?? 'build default'})`);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'dump') await dump(rest);
  else if (cmd === 'world-v1') await worldV1(rest);
  else if (cmd === 'compare') {
    const b = arg(rest, '--base'); const a = arg(rest, '--arm');
    if (!b || !a) fail('compare needs --base and --arm.', 'it compares two dumps by identity.', 'bun scripts/q2-typing-dev.ts compare --base base.json --arm arm.json');
    printCompare(JSON.parse(readFileSync(b!, 'utf8')), JSON.parse(readFileSync(a!, 'utf8')), rest.includes('--json'));
  } else fail(`unknown command ${cmd ?? '(none)'}.`, 'the commands are dump, compare and world-v1.', 'bun scripts/q2-typing-dev.ts dump --help is not needed: read the header of scripts/q2-typing-dev.ts');
}
