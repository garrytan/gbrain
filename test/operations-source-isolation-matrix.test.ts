/**
 * B2 (test-gap wave 2) — registry-walking source-isolation matrix.
 *
 * Every non-localOnly `scope: 'read'` op gets an explicit disposition:
 *   - 'isolated'  — under a remote ctx pinned to srcalpha (scalar) and a
 *                   federated grant ['srcalpha'], NOTHING carrying srcbeta
 *                   identity may return. Anti-vacuity: a trusted local
 *                   control call (brain-wide, else srcbeta-scoped — some
 *                   engine reads default to 'default' when unscoped) MUST
 *                   see the beta marker first; an op whose control can't
 *                   see beta FAILS loudly (inadequate fixture), never
 *                   passes vacuously. Ops whose results echo caller args
 *                   (entity/slug/id) carry a custom data-field probe
 *                   instead of the whole-JSON scan — an input echo is not
 *                   a leak.
 *   - 'brainwide' — deliberately brain-wide; rationale string required.
 *                   Must not throw under a scoped remote ctx.
 *   - 'skip'      — not exercisable hermetically here; reason + pointer to
 *                   the owning suite.
 *
 * The table is the ratchet: it must cover the registry EXACTLY, so a new
 * read op fails this suite until classified — isolated by default,
 * brain-wide only with a written rationale.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { readOps } from './helpers/ops-registry.ts';
import { linkEntityIdentity } from '../src/core/entity-identity.ts';

let engine: PGLiteEngine;

const LEAK_TOKENS = ['srcbeta', 'BETAMARKER', 'beta-secret', 'beta-person', 'beta-note', 'beta-topic', 'betamarkerdim', 'betamarkertype'];

function leakToken(payload: unknown): string | null {
  const text = JSON.stringify(payload) ?? '';
  for (const t of LEAK_TOKENS) if (text.includes(t)) return t;
  return null;
}

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    ...overrides,
  } as OperationContext;
}
const localWide = () => ctxOf({ remote: false, sourceId: undefined });
const localBeta = () => ctxOf({ remote: false, sourceId: 'srcbeta' });
const scopedScalar = () => ctxOf({ sourceId: 'srcalpha' });
const scopedFederated = () => ctxOf({ auth: { allowedSources: ['srcalpha'] } as any });

interface IsolatedRow {
  name: string;
  mode: 'isolated';
  args: Record<string, unknown>;
  /** Custom control-visibility probe (echo ops); default = whole-JSON leak scan. */
  controlSees?: (result: unknown) => boolean;
  /**
   * Custom scoped assertion (echo ops); default = whole-JSON no-leak scan.
   * Receives the ctx label so a row can express DIFFERENT contracts for the
   * scalar default-source floor vs a federated grant (the #4433 boundary —
   * see the sources_status row).
   */
  expectScoped?: (result: unknown, ctxLabel: 'scalar' | 'federated') => void;
}
type Row =
  | IsolatedRow
  | { name: string; mode: 'brainwide'; args: Record<string, unknown>; rationale: string }
  | { name: string; mode: 'skip'; reason: string };

// All wall-clock fixtures derive from ONE instant captured at module load, so
// the MATRIX args and the beforeAll fixtures can never straddle midnight.
// The prior-year date subtracts 365 days (leap-day-safe: never fabricates an
// invalid `<year-1>-02-29`), then normalizes a Feb 29 landing to Feb 28 so
// its month-day exists in EVERY year. (Same fixed-date discipline the
// chronicle-ops-scope suite documents.)
const CAPTURED_NOW_MS = Date.now();
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const TODAY = isoDay(CAPTURED_NOW_MS);
const DAYS_AGO_7 = isoDay(CAPTURED_NOW_MS - 7 * 86_400_000);
let anniversaryMs = CAPTURED_NOW_MS - 365 * 86_400_000;
if (isoDay(anniversaryMs).endsWith('-02-29')) anniversaryMs -= 86_400_000;
const ANNIVERSARY = isoDay(anniversaryMs);
// chronicle_on_this_day matches the month-day of an EXPLICIT anchor against
// prior-year rows. Deriving the anchor from ANNIVERSARY (same month-day, a
// strictly later year) keeps the pair matched on every calendar day —
// relying on the implicit current_date anchor would miss the fixture
// whenever a Feb 29 sits between ANNIVERSARY and today.
const ANNIVERSARY_MMDD = ANNIVERSARY.slice(5);
const SAME_MMDD_THIS_YEAR = `${TODAY.slice(0, 4)}-${ANNIVERSARY_MMDD}`;
const ON_THIS_DAY_ANCHOR = SAME_MMDD_THIS_YEAR > ANNIVERSARY
  ? SAME_MMDD_THIS_YEAR
  : `${Number(TODAY.slice(0, 4)) + 1}-${ANNIVERSARY_MMDD}`;

// ─── The matrix ────────────────────────────────────────────────────────────
const MATRIX: Row[] = [
  // LLM/eval/pipeline-dependent — owned by dedicated suites.
  { name: 'entity', mode: 'skip', reason: 'MEMORY_VERBS conformance suite owns it; LLM-shaped output' },
  { name: 'synthesize', mode: 'skip', reason: 'LLM-dependent; keyless envs cannot run it — verbs conformance owns the error path' },
  { name: 'think', mode: 'skip', reason: 'LLM-dependent; think-source-isolation-pglite e2e owns its scoping' },
  { name: 'search_by_image', mode: 'skip', reason: 'needs image-embedding infra; cross-modal suites own it' },
  { name: 'volunteer_context', mode: 'skip', reason: 'session/reflex machinery; volunteer-context suites own scoping' },
  { name: 'context_pack', mode: 'skip', reason: 'verbs conformance owns it; budget-packed composite of scoped reads' },
  { name: 'delta', mode: 'skip', reason: 'session-cursor verb; conformance suite owns it — page-delta arm is session-coupled (probe: fresh writes not listed)' },
  { name: 'find_trajectory', mode: 'skip', reason: 'typed-claim/event rows come from the extraction pipeline; eval-trajectory + facts suites own it (probe: hand-seeded claim rows do not surface)' },
  { name: 'ontology_conflicts', mode: 'skip', reason: 'conflict rows need the ontology merge pipeline cross-observation shape; D7 ontology-merge parity suite owns conflicts' },
  { name: 'get_skill', mode: 'skip', reason: 'skills catalog + brain-resident packs; skill-catalog confinement suites own it' },
  { name: 'list_brain_skillpack', mode: 'skip', reason: 'brain-resident skillpack surface; skillpack suites own it' },
  { name: 'advisor', mode: 'skip', reason: 'aggregate advisory over full stack; advisor suites own it' },
  { name: 'open_loops', mode: 'skip', reason: 'loop rows need the Gmail detector pipeline; test/ops-loops.test.ts owns its remote posture (no-scope denial, grant confinement, redacted evidence)' },
  { name: 'list_skills', mode: 'skip', reason: 'bundled skills catalog from the install tree; skills suites own it (throws outside an installed skills dir)' },

  // Deliberately brain-wide (config / registry / identity — not source data).
  { name: 'search_modes', mode: 'brainwide', args: {}, rationale: 'reports search config knobs, no page data' },
  { name: 'get_brain_identity', mode: 'brainwide', args: {}, rationale: 'brain-level identity document by design' },
  { name: 'whoami', mode: 'brainwide', args: {}, rationale: 'caller identity/transport echo, no page data' },
  { name: 'sources_list', mode: 'brainwide', args: {}, rationale: 'listing sources is its purpose; exposes ids/names only' },
  { name: 'request_tools', mode: 'brainwide', args: { tools: ['get_page'] }, rationale: 'tool registry surface, no page data' },
  { name: 'list_link_sources', mode: 'brainwide', args: {}, rationale: 'distinct link-origin kinds; enumerates kinds not content' },
  { name: 'get_active_schema_pack', mode: 'brainwide', args: {}, rationale: 'brain-level schema config' },
  { name: 'list_schema_packs', mode: 'brainwide', args: {}, rationale: 'brain-level schema config' },
  { name: 'schema_graph', mode: 'brainwide', args: {}, rationale: 'schema-pack type graph, not page data' },
  { name: 'schema_explain_type', mode: 'brainwide', args: { type: 'note' }, rationale: 'schema-pack type doc, not page data' },
  { name: 'schema_lint', mode: 'brainwide', args: {}, rationale: 'lints the schema pack, not page data' },
  { name: 'get_calibration_profile', mode: 'brainwide', args: {}, rationale: 'holder-keyed calibration aggregates; per-source split tracked in takes suites' },
  { name: 'takes_scorecard', mode: 'brainwide', args: {}, rationale: 'holder-keyed scorecard aggregates (numbers); slug projection is takes-suite scope' },
  { name: 'takes_calibration', mode: 'brainwide', args: {}, rationale: 'holder-keyed calibration buckets; aggregate numbers' },

  // Isolated — the core of the matrix.
  { name: 'get_page', mode: 'isolated', args: { slug: 'notes/beta-note' },
    controlSees: r => r !== null && JSON.stringify(r).includes('BETAMARKER'),
    expectScoped: r => { expect(r === null || leakToken(r) === null).toBe(true); } },
  // v0.46.28.0+ master ops (mapped at the test-gap-wave master merge): fetch
  // shares get_page's scope ladder; entity_identity_list filters members via
  // identityReadScope.
  { name: 'fetch', mode: 'isolated', args: { id: 'notes/beta-note' },
    controlSees: r => r !== null && JSON.stringify(r).includes('BETAMARKER'),
    expectScoped: r => { expect(r === null || leakToken(r) === null).toBe(true); } },
  { name: 'entity_identity_list', mode: 'isolated', args: {} },
  { name: 'list_pages', mode: 'isolated', args: { limit: 100 } },
  { name: 'search', mode: 'isolated', args: { query: 'BETAMARKER', limit: 20 } },
  { name: 'query', mode: 'isolated', args: { query: 'BETAMARKER', limit: 20 } },
  { name: 'get_tags', mode: 'isolated', args: { slug: 'notes/beta-note' } },
  { name: 'get_links', mode: 'isolated', args: { slug: 'notes/beta-note' } },
  { name: 'get_backlinks', mode: 'isolated', args: { slug: 'people/beta-person' } },
  { name: 'traverse_graph', mode: 'isolated', args: { slug: 'notes/beta-note', depth: 2 } },
  { name: 'get_timeline', mode: 'isolated', args: { slug: 'people/beta-person' } },
  { name: 'get_versions', mode: 'isolated', args: { slug: 'notes/beta-note' } },
  { name: 'get_raw_data', mode: 'isolated', args: { slug: 'notes/beta-note' } },
  { name: 'resolve_slugs', mode: 'isolated', args: { partial: 'beta' } },
  { name: 'get_chunks', mode: 'isolated', args: { slug: 'notes/beta-note' } },
  { name: 'get_ingest_log', mode: 'isolated', args: { limit: 50 } },
  { name: 'find_orphans', mode: 'isolated', args: {} },
  { name: 'takes_list', mode: 'isolated', args: { limit: 50 } },
  { name: 'takes_search', mode: 'isolated', args: { query: 'BETAMARKER', limit: 20 } },
  { name: 'get_recent_salience', mode: 'isolated', args: { limit: 50 } },
  { name: 'find_anomalies', mode: 'isolated', args: {} },
  { name: 'recall', mode: 'isolated', args: { query: 'BETAMARKER', limit: 20 } },
  { name: 'find_contradictions', mode: 'isolated', args: {} },
  { name: 'find_experts', mode: 'isolated', args: { topic: 'BETAMARKER', limit: 10 } },
  { name: 'chronicle_day', mode: 'isolated', args: { date: TODAY } },
  { name: 'chronicle_on_this_day', mode: 'isolated', args: { date: ON_THIS_DAY_ANCHOR } },
  { name: 'chronicle_since', mode: 'isolated', args: { date: DAYS_AGO_7 } },
  { name: 'chronicle_last_seen', mode: 'isolated', args: { entity: 'people/beta-person' },
    controlSees: r => (r as { last_date?: string | null })?.last_date != null,
    expectScoped: r => {
      const res = r as { last_date?: string | null; last_event_slug?: string | null };
      expect(res.last_date ?? null).toBeNull();
      expect(res.last_event_slug ?? null).toBeNull();
    } },
  { name: 'ontology_get', mode: 'isolated', args: { entity: 'people/beta-person', include_quarantined: true },
    controlSees: r => JSON.stringify(r).includes('BETAMARKER'),
    expectScoped: r => {
      const text = JSON.stringify(r);
      expect(text.includes('BETAMARKER')).toBe(false);
      expect(text.includes('betamarkerdim')).toBe(false);
    } },
  { name: 'ontology_dimensions', mode: 'isolated', args: {} },
  { name: 'volunteer_chronicle', mode: 'isolated', args: { days: 30, limit: 50 } },
  { name: 'extraction_pending', mode: 'isolated', args: { limit: 50 } },
  // #4433 wave-L posture (mirrors sources_list): EVERY untrusted scope —
  // federated grant AND scalar bound source — confines sources_status; an
  // out-of-scope id answers not_found (the walk's fail-closed catch arm
  // handles the throw, so REACHING expectScoped under either ctx is itself
  // the failure). Trusted local keeps the full operator view (the control).
  { name: 'sources_status', mode: 'isolated', args: { id: 'srcbeta' },
    controlSees: r => JSON.stringify(r).includes('srcbeta'),
    expectScoped: () => {
      throw new Error('sources_status must fail closed (not_found) for out-of-scope ids under any untrusted ctx');
    } },
  { name: 'schema_stats', mode: 'isolated', args: {} },
  { name: 'schema_review_orphans', mode: 'isolated', args: { limit: 50 } },

  // Code-intel — focused scoping suites own these (A13 + code-intel e2e);
  // the code-index fixture pipeline is too heavy to duplicate here.
  { name: 'code_callers', mode: 'skip', reason: 'scoping pinned in code-intel-mcp-ops e2e' },
  { name: 'code_callees', mode: 'skip', reason: 'scoping pinned in code-intel-mcp-ops e2e' },
  { name: 'code_def', mode: 'skip', reason: 'A13 code-intel-source-scope suite owns it' },
  { name: 'code_refs', mode: 'skip', reason: 'A13 code-intel-source-scope suite owns it' },
  { name: 'code_blast', mode: 'skip', reason: 'A13 suite owns it (resolveCodeIntelScope fence)' },
  { name: 'code_flow', mode: 'skip', reason: 'A13 suite owns it (resolveCodeIntelScope fence)' },
];

// ─── Fixture ───────────────────────────────────────────────────────────────
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (const name of ['alpha', 'beta'] as const) {
    const src = `src${name}`;
    const MARK = name === 'beta' ? 'BETAMARKER' : 'ALPHAMARK';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2) ON CONFLICT (id) DO NOTHING`,
      [src, `/tmp/${src}`],
    );
    await engine.putPage(`people/${name}-person`, {
      type: 'person', title: `${MARK} Person`, compiled_truth: `${MARK} person truth`, frontmatter: {},
    }, { sourceId: src });
    await engine.putPage(`notes/${name}-note`, {
      type: 'note', title: `${MARK} Note`, compiled_truth: `${name}-secret-content ${MARK}`,
      timeline: `- ${TODAY}: ${MARK} timeline entry`, frontmatter: { marker: MARK },
    }, { sourceId: src });
    // Typeless page: schema_review_orphans lists pages with NULL/empty type.
    await engine.putPage(`misc/${name}-orphan`, {
      type: 'note', title: `${MARK} Orphan`, compiled_truth: `${MARK} orphan`, frontmatter: {},
    }, { sourceId: src });
    await engine.executeRaw(`UPDATE pages SET type = '' WHERE slug = $1 AND source_id = $2`, [`misc/${name}-orphan`, src]);
    // Auto-extracted unverified stub: extraction_pending surface.
    await engine.putPage(`stubs/${name}-stub`, {
      type: 'person', title: `${MARK} Stub`, compiled_truth: `${MARK} stub`,
      frontmatter: { provenance: 'auto-extracted', status: 'unverified' },
    }, { sourceId: src });
    // Cross-source identity group so entity_identity_list has something to
    // leak: the beta member's slug ('people/beta-person') is a LEAK_TOKEN.
    await linkEntityIdentity(engine, {
      entityId: 'matrix-person', slug: `people/${name}-person`, sourceId: src,
    });
    await engine.addTag(`notes/${name}-note`, `${name}-topic`, { sourceId: src });
    await engine.addTag(`people/${name}-person`, `${name}-topic`, { sourceId: src });
    await engine.addLink(`notes/${name}-note`, `people/${name}-person`, `${MARK} ctx`, 'mentions', 'markdown', undefined, undefined, { fromSourceId: src, toSourceId: src });
    await engine.upsertChunks(`notes/${name}-note`, [{
      chunk_index: 0, chunk_text: `${MARK} chunk text ${name}-secret-content`, chunk_source: 'compiled_truth', token_count: 5,
    }], { sourceId: src });
    await engine.createVersion(`notes/${name}-note`, { sourceId: src });
    await engine.putRawData(`notes/${name}-note`, 'crm', { owner: MARK }, { sourceId: src });
    await engine.logIngest({
      source_id: src, source_type: 'test', source_ref: `${MARK}-ref`,
      pages_updated: [`notes/${name}-note`], summary: `${MARK} ingest summary`,
    });
    await engine.insertFact({
      fact: `${MARK} works at ${MARK}Corp`, entity_slug: `people/${name}-person`,
      source: 'test:matrix', visibility: 'world', embedding: null,
    }, { source_id: src });
    // Ontology observation with a marker-bearing DIMENSION name so the
    // dimensions listing itself is probeable.
    await engine.mergeOntologyFact({
      entitySlug: `people/${name}-person`, dimension: `${name}markerdim`, value: `${MARK}Corp`,
      confidence: 0.9, source: `test:${name}`, sourceId: src,
    } as any);
    // Chronicle events: one today, one a year ago (on_this_day matches the
    // prior-year row against the ON_THIS_DAY_ANCHOR arg's month-day).
    await engine.upsertEventProjection({
      depthSlug: `people/${name}-person`, eventSlug: `notes/${name}-note`,
      date: TODAY, summary: `${MARK} event summary`, sourceId: src,
    });
    await engine.upsertEventProjection({
      depthSlug: `people/${name}-person`, eventSlug: `misc/${name}-orphan`,
      date: ANNIVERSARY, summary: `${MARK} anniversary event`, sourceId: src,
    });
    const page = await engine.getPage(`notes/${name}-note`, { sourceId: src });
    if (page) {
      await engine.addTakesBatch([{
        page_id: (page as any).id, row_num: 1, claim: `${MARK} take claim`,
        kind: 'view', holder: `${name}-holder`, weight: 0.8,
      }] as any);
    }
  }
  // Contradictions probe report (both-endpoints-beta finding).
  await (engine as any).writeContradictionsRun({
    run_id: 'matrix-run-1', judge_model: 'test', prompt_version: 'v1',
    queries_evaluated: 1, queries_with_contradiction: 1, total_contradictions_flagged: 1,
    wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0,
    cost_usd_total: 0, duration_ms: 1, source_tier_breakdown: {},
    report_json: {
      per_query: [{
        contradictions: [{
          kind: 'direct', severity: 'high', axis: 'fact', confidence: 0.9,
          a: { slug: 'notes/beta-note', chunk_id: null, take_id: null },
          b: { slug: 'people/beta-person', chunk_id: null, take_id: null },
          resolution_kind: 'manual', resolution_command: '',
        }],
      }],
    },
  });
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

// ─── Ratchet: the table covers the registry exactly ───────────────────────
describe('matrix coverage ratchet', () => {
  test('every non-localOnly read op has exactly one disposition row', () => {
    // Shared enumeration seam (test/helpers/ops-registry.ts): one definition
    // of "the remotely-servable read surface" across every sweeping suite.
    const registry = readOps().map(o => o.name).sort();
    const table = MATRIX.map(r => r.name).sort();
    expect(table).toEqual(registry);
    const dupes = table.filter((n, i) => table.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});

// ─── The walk ──────────────────────────────────────────────────────────────
describe('source isolation matrix', () => {
  for (const row of MATRIX) {
    if (row.mode === 'skip') {
      test(`SKIP ${row.name} — ${row.reason}`, () => {
        expect(row.reason.length).toBeGreaterThan(10);
      });
      continue;
    }
    const op = operations.find(o => o.name === row.name)!;

    if (row.mode === 'brainwide') {
      test(`BRAIN-WIDE ${row.name} — ${row.rationale}`, async () => {
        await op.handler(scopedScalar(), row.args);
      });
      continue;
    }

    test(`ISOLATED ${row.name}`, async () => {
      // Anti-vacuity control ladder: brain-wide local first; some engine
      // reads default to 'default' when unscoped, so fall back to a
      // srcbeta-scoped LOCAL ctx. Something must see beta or the test fails.
      const sees = row.controlSees ?? ((r: unknown) => leakToken(r) !== null);
      let controlOk = false;
      let lastErr: string | null = null;
      for (const ctl of [localWide(), localBeta()]) {
        try {
          if (sees(await op.handler(ctl, row.args))) { controlOk = true; break; }
        } catch (e) {
          lastErr = (e as Error).message;
        }
      }
      if (!controlOk) {
        throw new Error(`${row.name}: VACUOUS — no control ctx can see the beta marker` + (lastErr ? ` (last error: ${lastErr})` : '') + '; fix the fixture or reclassify with a reason');
      }
      for (const [label, ctx] of [['scalar', scopedScalar()], ['federated', scopedFederated()]] as const) {
        let result: unknown;
        try {
          result = await op.handler(ctx, row.args);
        } catch (e) {
          // A scoped refusal is acceptable ONLY as a typed fail-closed
          // OperationError (not_found / page_not_found — the page-read ops'
          // anti-enumeration miss shape / permission_denied / invalid_params).
          // Anything else — a crash, an engine error, a mistyped code — is a
          // real failure a bare `continue` used to swallow silently.
          if (e instanceof OperationError
            && ['not_found', 'page_not_found', 'permission_denied', 'invalid_params'].includes(e.code)) {
            continue;
          }
          throw e;
        }
        if (row.expectScoped) {
          row.expectScoped(result, label);
        } else {
          const leaked = leakToken(result);
          if (leaked) {
            throw new Error(`${row.name}: LEAK under ${label} scope — '${leaked}' visible to a caller scoped to srcalpha`);
          }
        }
      }
    });
  }
});
