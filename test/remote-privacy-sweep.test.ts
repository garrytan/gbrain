/**
 * Remote privacy sweep — DYNAMIC, corpus-seeded leak detection across the
 * ENTIRE dispatch surface (#4546/#4549 class closure at the dispatch layer).
 *
 * Why this exists: the world-only privacy boundary is enforced per-arm /
 * per-column at N call sites, so it leaked twice arm-by-arm — #4546 (a
 * takes/private-facts fence living in the `timeline` column was returned
 * unstripped to remote readers) and #4549 (delta's changed-page arm exposed
 * private page titles/slugs). This suite closes the CLASS at the shared
 * layer: seed a corpus carrying high-entropy PRIVATE sentinels, enumerate
 * every non-localOnly op from the registry, dispatch each one remote-shaped
 * through `dispatchToolCall` (the exact layer both MCP transports share),
 * and assert no private sentinel appears anywhere in the serialized
 * response envelope — structured fields, rendered text, error messages,
 * and the `_meta.brain_hot_memory` channel alike.
 *
 * Scope claim, stated honestly: this closes the DISPATCH surface for
 * callers that carry the transport floor (`sourceId` + world-only
 * takesHoldersAllowList — every shipped transport sets both). It does NOT
 * cover the IPC context-pack surface (src/mcp/context-pack-handler.ts,
 * which bypasses dispatchToolCall) nor write-triggered restoration echoes
 * (put_page INTO fence-bearing pages — see the write-side sweep TODO).
 *
 * Static sibling: test/operations-trust-boundary.test.ts (contract
 * assertions + curated handler probes) and
 * scripts/check-operations-filter-bypass.sh. This file is the dynamic
 * sibling — same doctrine, corpus-seeded.
 *
 * MAINTENANCE CONTRACT (fail-closed): adding a new operation to the
 * registry makes this suite FAIL until the op is classified in
 * EXPECTED_OUTCOME below (and, if it can return corpus data, given a
 * PARAM_FACTORY entry). The failure message prints exactly what to add.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import {
  resetGateway,
  __setChatTransportForTests,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { __setUsageLogPathForTests } from '../src/core/verbs/usage-log.ts';

// ── Sentinels ────────────────────────────────────────────────────────────
// PRIVATE sentinels: high-entropy, seeded ONLY into private artifacts
// (titles / bodies / fact / take / fence-row CONTENT — never slugs: slugs
// are legitimately echoed in "Page not found: <slug>" errors, so a slug
// sentinel would false-positive on correct behavior).
const PRIV = {
  pageTitle: 'PRIVSWEEP_TITLE_kx9q3z',
  pageBody: 'PRIVSWEEP_PBODY_mw7r2v',
  fact: 'PRIVSWEEP_FACT_tj5n8d',
  take: 'PRIVSWEEP_TAKE_qb4h6y',
  fenceRow: 'PRIVSWEEP_FROW_zc3f9m',
  src2Fact: 'PRIVSWEEP_S2FACT_ne2k7p',
  src2Title: 'PRIVSWEEP_S2TITLE_ru8d4w',
} as const;
const PRIVATE_SENTINELS = Object.values(PRIV);

// WORLD markers: positive controls proving an op actually read the corpus
// (a sweep against an empty brain proves nothing).
const WORLD = {
  pageTitle: 'WORLDSWEEP_TITLE_ok11aa',
  pageBody: 'WORLDSWEEP_PBODY_ok22bb',
  fact: 'WORLDSWEEP_FACT_ok33cc',
  take: 'WORLDSWEEP_TAKE_ok44dd',
  fenceRow: 'WORLDSWEEP_FROW_ok55ee',
  timeline: 'WORLDSWEEP_TL_ok66ff',
  src2Page: 'WORLDSWEEP_S2PAGE_ok77gg',
} as const;
const WORLD_MARKERS = Object.values(WORLD);

const SRC2 = 'sweepsrc2';
/** Per-generated-case bun test timeout — a hanging op fails ITS case loudly. */
const CASE_TIMEOUT_MS = 20_000;
/** A cursor older than every seeded row, shared by the delta factory + anchors. */
const SINCE_EPOCH = '2020-01-01T00:00:00.000Z';
const WORLD_FENCE_SLUG = 'people/world-fence-example';
const WORLD_PAGE_SLUG = 'people/world-page-example';
const PRIV_PAGE_SLUG = 'people/priv-page-example';

// Known, reviewed op-wide exemptions. An entry here exempts the WHOLE op
// from the sentinel assertion (the substring check cannot do field-level).
// MUST stay empty absent a written justification + review.
const KNOWN_EXPOSED: Record<string, { why: string }> = {};

let engine: PGLiteEngine;
let home: string;
let src2Dir: string;
let brainDir: string;

function localCtx(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  } as unknown as OperationContext;
}

type Shape = 'scalar' | 'federated';

/**
 * Remote-shaped call through the shared dispatcher — the same opts shape
 * both shipped transports build (see src/mcp/server.ts and
 * src/commands/serve-http.ts): remote:true, non-stdio transport, sourceId
 * resolved, world-only takes floor, hot-memory metaHook. The `federated`
 * shape adds the auth-array read grant (the #1393 leak lived in that
 * precedence path); it still carries sourceId — dispatch hard-fails remote
 * calls without one (missing_source_scope, dispatch.ts) exactly like the
 * shipped HTTP transport, which always resolves a scalar default.
 */
async function sweepCall(name: string, params: Record<string, unknown>, shape: Shape) {
  return dispatchToolCall(engine, name, params, {
    remote: true,
    transport: 'http',
    takesHoldersAllowList: ['world'],
    sourceId: 'default',
    metaHook: getBrainHotMemoryMeta,
    ...(shape === 'federated'
      ? {
          auth: {
            token: 'test-token',
            clientId: 'test-client',
            scopes: ['read'],
            allowedSources: ['default', SRC2],
          },
        }
      : {}),
  });
}

// ── Per-op parameter factories ───────────────────────────────────────────
// Ops that need params to exercise the seeded corpus. Everything absent
// here dispatches with {} and must be classified 'ok' or 'error' below.
// A few explicit `{}` entries remain as "considered, takes no params"
// documentation — behaviorally identical to the fallback.
const PARAM_FACTORY: Record<string, Record<string, unknown>> = {
  get_page: { slug: WORLD_FENCE_SLUG, include_content: true },
  fetch: { id: WORLD_FENCE_SLUG },
  list_pages: {},
  search: { query: 'WORLDSWEEP' },
  query: { query: 'WORLDSWEEP' },
  recall: { entity: WORLD_PAGE_SLUG },
  entity: { name: WORLD_PAGE_SLUG },
  synthesize: { entity: WORLD_PAGE_SLUG },
  delta: { since: SINCE_EPOCH },
  context_pack: { entities: WORLD_PAGE_SLUG },
  get_timeline: { slug: WORLD_PAGE_SLUG },
  takes_list: { page_slug: WORLD_PAGE_SLUG },
  takes_search: { query: 'WORLDSWEEP' },
  get_tags: { slug: WORLD_PAGE_SLUG },
  get_links: { slug: WORLD_PAGE_SLUG },
  get_backlinks: { slug: WORLD_PAGE_SLUG },
  traverse_graph: { slug: WORLD_PAGE_SLUG },
  get_versions: { slug: WORLD_FENCE_SLUG },
  get_chunks: { slug: WORLD_FENCE_SLUG },
  resolve_slugs: { partial: 'world-page' },
  volunteer_context: { window: 'Recent discussion about WORLDSWEEP topics and pages.' },
  chronicle_day: { date: '2026-01-02' },
  chronicle_since: { date: '2020-01-01' },
  chronicle_on_this_day: { date: '2026-01-02' },
  chronicle_last_seen: { entity: WORLD_PAGE_SLUG },
  find_experts: { topic: 'WORLDSWEEP' },
  find_trajectory: { entity_slug: WORLD_PAGE_SLUG },
  find_contradictions: {},
  search_by_image: {},
  sources_status: { id: 'default' },
  ontology_get: { entity: WORLD_PAGE_SLUG },
  get_skill: { name: 'query' },
  // Mutating ops target FRESH slugs only — never the seeded corpus. The
  // put_page-into-fence-bearing-page restoration-echo class is explicitly
  // NOT covered here (write-side sweep TODO).
  put_page: { slug: 'notes/sweep-fresh-write', content: '# Fresh write\n\nNew content.\n' },
  remember: { fact: 'fresh sweep fact', provenance: 'sweep', entity: 'people/sweep-fresh-entity' },
  capture: { content: 'fresh sweep capture' },
  add_tag: { slug: WORLD_PAGE_SLUG, tag: 'sweep-tag' },
  remove_tag: { slug: WORLD_PAGE_SLUG, tag: 'sweep-tag' },
  add_link: { from: WORLD_PAGE_SLUG, to: WORLD_FENCE_SLUG },
  remove_link: { from: WORLD_PAGE_SLUG, to: WORLD_FENCE_SLUG },
  add_timeline_entry: { slug: WORLD_PAGE_SLUG, date: '2026-01-03', summary: 'fresh sweep timeline entry' },
  takes_add: { slug: WORLD_PAGE_SLUG, claim: 'fresh sweep take', kind: 'take', holder: 'world' },
  delete_page: { slug: 'notes/sweep-fresh-write' },
  restore_page: { slug: 'notes/sweep-fresh-write' },
};

// Per-(op × shape) overrides for ops whose behavior legitimately differs
// with vs without an authenticated OAuth identity (the federated shape
// carries ctx.auth; the scalar shape — like the stdio transport — doesn't).
const EXPECTED_BY_SHAPE: Record<string, Partial<Record<Shape, Outcome>>> = {
  whoami: { scalar: 'error', federated: 'ok' },
  list_jobs: { scalar: 'error', federated: 'ok' },
};

// ── Expected outcome per op ──────────────────────────────────────────────
// Buckets (asserted per case; the table's KEY SET must equal the enumerated
// non-localOnly registry — set equality is the fail-closed maintenance
// contract):
//   'data'   → succeeds AND response contains ≥1 WORLD marker (positive
//              control: the op provably read the corpus)
//   'ok'     → succeeds; no corpus-marker requirement
//   'error'  → isError (validation/unsupported/unavailable) — envelope
//              still sentinel-checked
//   'denied' → publish-gated: isError naming the gate (handler-level
//              permission_denied with the mcp.* config key)
type Outcome = 'data' | 'ok' | 'error' | 'denied';
const EXPECTED_OUTCOME: Record<string, Outcome> = {
  // reads that must prove corpus contact
  get_page: 'data',
  fetch: 'data',
  list_pages: 'data',
  search: 'data',
  query: 'data',
  recall: 'data',
  entity: 'data',
  delta: 'data',
  context_pack: 'data',
  get_timeline: 'data',
  takes_list: 'data',
  takes_search: 'data',
  get_versions: 'data',
  get_chunks: 'data',
  resolve_slugs: 'data',
  get_backlinks: 'data',
  traverse_graph: 'data',
  // reads that succeed without corpus-marker requirement
  get_tags: 'ok',
  get_links: 'ok',
  list_link_sources: 'ok',
  search_modes: 'ok',
  get_brain_identity: 'ok',
  whoami: 'ok', // base unused — per-shape override in EXPECTED_BY_SHAPE (above)
  sources_list: 'ok',
  sources_status: 'ok',
  find_orphans: 'ok',
  find_contradictions: 'ok',
  find_experts: 'ok',
  find_trajectory: 'ok',
  find_anomalies: 'ok',
  get_recent_salience: 'ok',
  chronicle_day: 'ok',
  chronicle_on_this_day: 'ok',
  chronicle_since: 'ok',
  chronicle_last_seen: 'ok',
  volunteer_chronicle: 'ok',
  volunteer_context: 'ok',
  get_calibration_profile: 'ok',
  takes_scorecard: 'ok',
  takes_calibration: 'ok',
  extraction_pending: 'ok',
  entity_identity_list: 'ok',
  // v0.47 open-loop engine: remote callers get the fail-closed REDACTED
  // envelope (counts + counterparty + summary + due; verbatim quotes, deep
  // links, and the injectable text digest are trusted-local only — pinned
  // in test/ops-loops.test.ts). Succeeds without corpus-marker requirement.
  open_loops: 'ok',
  get_active_schema_pack: 'ok',
  list_schema_packs: 'ok',
  schema_stats: 'ok',
  schema_graph: 'ok',
  ontology_get: 'ok',
  ontology_dimensions: 'ok',
  ontology_conflicts: 'ok',
  get_status_snapshot: 'ok',
  get_stats: 'ok',
  get_health: 'ok',
  search_stats: 'ok',
  cache_stats: 'ok',
  get_usage: 'ok',
  get_job_stats: 'ok',
  list_jobs: 'ok', // base unused — per-shape override in EXPECTED_BY_SHAPE (above)
  quarantine_list: 'ok',
  run_doctor: 'ok',
  get_ingest_log: 'ok',
  code_callers: 'error',
  code_callees: 'error',
  code_def: 'error',
  code_refs: 'error',
  code_blast: 'error',
  code_flow: 'error',
  schema_lint: 'ok',
  schema_explain_type: 'error',
  schema_review_orphans: 'ok',
  search_by_image: 'error',
  synthesize: 'error',
  think: 'error',
  request_tools: 'ok',
  get_raw_data: 'error',
  search_tune: 'ok',
  // publish-gated (DB-plane rows pinned false in beforeAll)
  list_skills: 'denied',
  get_skill: 'denied',
  list_brain_skillpack: 'denied',
  advisor: 'denied',
  // mutating ops (fresh-slug targets; envelope-echo checks only)
  remember: 'ok',
  forget: 'error',
  put_page: 'ok',
  delete_page: 'ok',
  restore_page: 'ok',
  capture: 'ok',
  add_tag: 'ok',
  remove_tag: 'ok',
  add_link: 'ok',
  remove_link: 'ok',
  add_timeline_entry: 'ok',
  revert_version: 'error',
  put_raw_data: 'error',
  log_ingest: 'error',
  takes_add: 'ok',
  takes_update: 'error',
  takes_resolve: 'error',
  takes_supersede: 'error',
  ontology_propose: 'error',
  extract_entities: 'error',
  extract_facts: 'error',
  forget_fact: 'error',
  schema_apply_mutations: 'error',
  reload_schema_pack: 'ok',
  run_onboard: 'ok',
  run_skillopt: 'error',
  sources_add: 'error',
  // v0.47 open-loop mutators: the sweep's generic invocation omits required
  // params (id/status, kind/value) → validation error. Remote-scope
  // semantics are pinned in test/ops-loops.test.ts (single-source grant
  // required for loops_close; loops_mute denied outside caller scope).
  loops_close: 'error',
  loops_mute: 'error',
  sources_remove: 'error',
  submit_job: 'error',
  get_job: 'error',
  cancel_job: 'error',
  retry_job: 'error',
  get_job_progress: 'error',
  pause_job: 'error',
  resume_job: 'error',
  replay_job: 'error',
  send_job_message: 'error',
  submit_agent: 'error',
  get_agent_job: 'error',
};

// Destructive mutating ops run LAST within phase W so an early
// generic-params delete can't defang later cases (eng review E5).
const DESTRUCTIVE_RE = /forget|purge|delete|remove|cancel|clear|repair|revert|resolve|supersede/;

const nonLocalOps = operations.filter(o => !o.localOnly);
const phaseR = nonLocalOps.filter(o => !o.mutating);
const phaseW = [...nonLocalOps.filter(o => o.mutating)].sort((a, b) => {
  const da = DESTRUCTIVE_RE.test(a.name) ? 1 : 0;
  const db = DESTRUCTIVE_RE.test(b.name) ? 1 : 0;
  return da - db || a.name.localeCompare(b.name);
});
const localOnlyOps = operations.filter(o => o.localOnly);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-privacy-sweep-'));
  src2Dir = mkdtempSync(join(tmpdir(), 'gbrain-privacy-sweep-src2-'));
  __setUsageLogPathForTests(join(home, 'usage.jsonl'));
  // Hermeticity is ENFORCED, not assumed: null BOTH gateway transports
  // (synthesize calls chat; embed paths call embed — a keyed dev machine
  // must not fire real API calls). The GBRAIN_REMOTE_PRIVATE_PAGES escape
  // hatch disables private-page exclusion outright — rather than mutating
  // process.env (banned in parallel test files by check-test-isolation R1),
  // fail LOUD: a machine running with privacy globally disabled SHOULD get
  // a red privacy sweep.
  // A previously-loaded file in the same bun process can leave the
  // MODULE-GLOBAL gateway configured (e.g. a deterministic embedder with
  // foreign dims) — reset config AND null transports so seeding can't trip
  // an inherited embedding path (same hygiene as memory-verbs-conformance).
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  if (process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') {
    throw new Error(
      'remote-privacy-sweep: GBRAIN_REMOTE_PRIVATE_PAGES=1 is set — the private-page ' +
        'exclusion is globally disabled, so this suite cannot prove anything. Unset it and re-run.',
    );
  }

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Takes are markdown-canonical — resolveTakesRepoDir reads the
  // `sync.repo_path` config key, so point it (and the default source's
  // local_path, for source-scoped writes) at a writable tmpdir.
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-privacy-sweep-brain-'));
  await engine.setConfig('sync.repo_path', brainDir);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);

  // buildOperationContext loads the REAL file-plane config; gate resolution
  // is DB > file > false — pin the DB plane so a dev machine with
  // mcp.publish_* enabled in ~/.gbrain config can't flip the denied arm.
  await engine.setConfig('mcp.publish_skills', 'false');
  await engine.setConfig('mcp.publish_advisor', 'false');

  // ── Seed the corpus (source: default) ──────────────────────────────
  const put = operationsByName['put_page'];
  // 1. World page whose PRIVATE fence rows live BELOW the timeline
  //    sentinel — the exact #4546 topology (a fence in the `timeline`
  //    column of a world-visible page; a fence on a private page would
  //    never reach a remote reader at all, making red-green check (a)
  //    unimplementable).
  await put.handler(localCtx(), {
    slug: WORLD_FENCE_SLUG,
    content: `---
title: ${WORLD.pageTitle}
type: person
---

# ${WORLD.pageTitle}

${WORLD.pageBody}

<!-- timeline -->

- 2026-01-02: ${WORLD.timeline}

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${WORLD.fenceRow} | fact | 1.0 | world | high | 2026-01-01 |  | s |  |
| 2 | ${PRIV.fenceRow} | fact | 1.0 | private | high | 2026-01-01 |  | s |  |
<!--- gbrain:facts:end -->
`,
  });
  // 2. Plain world page (RETURNS_DATA anchor for entity/graph/takes ops).
  await put.handler(localCtx(), {
    slug: WORLD_PAGE_SLUG,
    content: `---
title: WorldSweep Page ${WORLD.pageTitle}
type: person
---

# WorldSweep

${WORLD.pageBody}
`,
  });
  // 3. Private page — title AND body carry sentinels (the TITLE sentinel
  //    is what catches the #4549 metadata-leak shape in delta/list arms).
  await put.handler(localCtx(), {
    slug: PRIV_PAGE_SLUG,
    content: `---
title: ${PRIV.pageTitle}
type: person
visibility: private
---

# ${PRIV.pageTitle}

${PRIV.pageBody}
`,
  });
  // 4. Facts hot memory: one world, one private (also feeds the
  //    _meta.brain_hot_memory channel the metaHook injects).
  const remember = operationsByName['remember'];
  await remember.handler(localCtx(), {
    fact: WORLD.fact,
    provenance: 'sweep-seed',
    entity: WORLD_PAGE_SLUG,
  });
  await remember.handler(localCtx(), {
    fact: PRIV.fact,
    provenance: 'sweep-seed',
    entity: WORLD_PAGE_SLUG,
    visibility: 'private',
  });
  // 5. Takes: world-holder (visible through the transport floor) and
  //    brain-holder (must be filtered by takesHoldersAllowList).
  const takesAdd = operationsByName['takes_add'];
  await takesAdd.handler(localCtx(), {
    slug: WORLD_PAGE_SLUG,
    claim: WORLD.take,
    kind: 'take',
    holder: 'world',
  });
  await takesAdd.handler(localCtx(), {
    slug: WORLD_PAGE_SLUG,
    claim: PRIV.take,
    kind: 'take',
    holder: 'brain',
  });
  // ── Source 2 (federated-arm variants) ───────────────────────────────
  // Direct row insert: sources_add demands a committed git repo (sync
  // machinery we don't exercise); registration is all the sweep needs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(`INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)`, [
    SRC2,
    src2Dir,
  ]);
  await put.handler(localCtx(SRC2), {
    slug: PRIV_PAGE_SLUG,
    content: `---
title: ${PRIV.src2Title}
type: person
visibility: private
---

# ${PRIV.src2Title}

private source-2 body
`,
  });
  await remember.handler(localCtx(SRC2), {
    fact: PRIV.src2Fact,
    provenance: 'sweep-seed',
    entity: WORLD_PAGE_SLUG,
    visibility: 'private',
  });
  // World-visible src2 page: the federated arm's positive control — without
  // it, every src2 sentinel could pass vacuously if allowedSources fan-out
  // silently never reached source 2 (the "sweep against an empty brain
  // proves nothing" failure mode, cross-source edition).
  await put.handler(localCtx(SRC2), {
    slug: 'people/world-src2-example',
    content: `---
title: ${WORLD.src2Page}
type: person
---

# ${WORLD.src2Page}

world source-2 body
`,
  });
});

afterAll(async () => {
  await engine.disconnect();
  __setUsageLogPathForTests(null);
  // Leave the process exactly as found: reset gateway config + transports
  // so later files in this shard process inherit a clean module-global.
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(src2Dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── The core per-case assertion ──────────────────────────────────────────
function assertNoPrivateSentinel(op: string, serialized: string) {
  if (KNOWN_EXPOSED[op]) return; // op-wide, reviewed exemption
  for (const s of PRIVATE_SENTINELS) {
    if (serialized.includes(s)) {
      throw new Error(
        `PRIVACY LEAK: op "${op}" returned private sentinel "${s}" to a remote caller.\n` +
          `Envelope excerpt: ${serialized.slice(Math.max(0, serialized.indexOf(s) - 200), serialized.indexOf(s) + 200)}`,
      );
    }
  }
}

async function runCase(opName: string, shape: Shape) {
  const params = PARAM_FACTORY[opName] ?? {};
  const res = await sweepCall(opName, params, shape);
  const serialized = JSON.stringify(res);
  assertNoPrivateSentinel(opName, serialized);
  const expected = EXPECTED_BY_SHAPE[opName]?.[shape] ?? EXPECTED_OUTCOME[opName];
  const isError = res.isError === true;
  if (expected === 'data') {
    expect(isError).toBe(false);
    const hasMarker = WORLD_MARKERS.some(m => serialized.includes(m));
    if (!hasMarker) {
      throw new Error(
        `Op "${opName}" [${shape}] expected 'data' (a WORLD marker proving corpus contact) but returned none.\n` +
          `Either fix its PARAM_FACTORY entry or reclassify in EXPECTED_OUTCOME.\nEnvelope: ${serialized.slice(0, 600)}`,
      );
    }
  } else if (expected === 'ok') {
    if (isError) {
      throw new Error(
        `Op "${opName}" [${shape}] expected 'ok' but errored. Reclassify in EXPECTED_OUTCOME ` +
          `or fix its PARAM_FACTORY entry.\nEnvelope: ${serialized.slice(0, 600)}`,
      );
    }
  } else if (expected === 'error') {
    if (!isError) {
      throw new Error(
        `Op "${opName}" [${shape}] expected 'error' but succeeded — reclassify in EXPECTED_OUTCOME ` +
          `(and decide whether it needs a positive control).\nEnvelope: ${serialized.slice(0, 600)}`,
      );
    }
  } else if (expected === 'denied') {
    expect(isError).toBe(true);
    // Handler-level publish gate: permission_denied naming the mcp.* key.
    expect(serialized).toContain('permission_denied');
    expect(serialized).toContain('mcp.');
  }
  return serialized;
}

// Corpus-intact probe: the world fence page still serves its world row.
async function assertCorpusIntact(label: string) {
  const res = await sweepCall('get_page', PARAM_FACTORY['get_page']!, 'scalar');
  const serialized = JSON.stringify(res);
  expect(res.isError ?? false).toBe(false);
  if (!serialized.includes(WORLD.fenceRow)) {
    throw new Error(`Corpus integrity lost at "${label}" — world fence row missing. A mutating op touched the seeded corpus.`);
  }
  assertNoPrivateSentinel('get_page', serialized);
}

// ── Enumeration guards (vacuous-pass protection) ─────────────────────────
describe('remote privacy sweep — enumeration + classification contract', () => {
  it('registry enumeration is non-vacuous (≥30 non-localOnly ops)', () => {
    expect(nonLocalOps.length).toBeGreaterThanOrEqual(30);
  });

  it('EXPECTED_OUTCOME keys set-equal the enumerated registry (maintenance contract)', () => {
    const enumerated = new Set(nonLocalOps.map(o => o.name));
    const classified = new Set(Object.keys(EXPECTED_OUTCOME));
    const missing = [...enumerated].filter(n => !classified.has(n)).sort();
    const stale = [...classified].filter(n => !enumerated.has(n)).sort();
    if (missing.length > 0 || stale.length > 0) {
      throw new Error(
        `remote-privacy-sweep classification drift.\n` +
          (missing.length
            ? `NEW ops needing classification in EXPECTED_OUTCOME (and a PARAM_FACTORY entry if they can return corpus data):\n  ${missing.join(', ')}\n`
            : '') +
          (stale.length ? `STALE entries for removed/renamed ops:\n  ${stale.join(', ')}\n` : '') +
          `This is the fail-closed maintenance contract: every remote-callable op MUST be privacy-swept.`,
      );
    }
  });

  it("'data' bucket is non-vacuous (≥15 positive-control ops)", () => {
    const dataOps = Object.entries(EXPECTED_OUTCOME).filter(([, v]) => v === 'data');
    expect(dataOps.length).toBeGreaterThanOrEqual(15);
  });

  it('KNOWN_EXPOSED is empty (any entry is a reviewed decision)', () => {
    expect(Object.keys(KNOWN_EXPOSED)).toHaveLength(0);
  });
});

// ── Phase R: non-mutating ops, pristine corpus, both ctx shapes ──────────
describe('phase R — non-mutating ops leak no private sentinel', () => {
  for (const op of phaseR) {
    for (const shape of ['scalar', 'federated'] as const) {
      it(`${op.name} [${shape}]`, async () => {
        await runCase(op.name, shape);
      }, CASE_TIMEOUT_MS);
    }
  }

  it('corpus intact at end of phase R (mutability misclassification guard)', async () => {
    await assertCorpusIntact('end of phase R');
  });
});

// ── Phase W: mutating ops (fresh-slug targets), destructive last ─────────
describe('phase W — mutating ops leak no private sentinel in response envelopes', () => {
  it('corpus intact at start of phase W', async () => {
    await assertCorpusIntact('start of phase W');
  });

  for (const op of phaseW) {
    for (const shape of ['scalar', 'federated'] as const) {
      it(`${op.name} [${shape}]`, async () => {
        await runCase(op.name, shape);
      }, CASE_TIMEOUT_MS);
    }
  }
});

// ── Fail-closed arm: localOnly ops deny on non-stdio transports ──────────
describe('localOnly ops are denied fail-closed over non-stdio transports', () => {
  for (const op of localOnlyOps) {
    it(`${op.name} → unknown_tool envelope, no sentinel`, async () => {
      const res = await sweepCall(op.name, {}, 'scalar');
      const serialized = JSON.stringify(res);
      expect(res.isError).toBe(true);
      // The dispatcher backstop (dispatch.ts localOnly gate) answers with
      // the same envelope as a nonexistent op so the catalog doesn't leak.
      expect(serialized).toContain('unknown_tool');
      assertNoPrivateSentinel(op.name, serialized);
    }, CASE_TIMEOUT_MS);
  }
});

// ── Discrimination anchors: the two known leak shapes stay caught ────────
describe('known-leak discrimination anchors (#4546 / #4549)', () => {
  it('#4546 shape: remote get_page serves the world fence row but never the private row (timeline column)', async () => {
    const res = await sweepCall('get_page', { slug: WORLD_FENCE_SLUG, include_content: true }, 'scalar');
    const serialized = JSON.stringify(res);
    expect(res.isError ?? false).toBe(false);
    expect(serialized).toContain(WORLD.fenceRow);
    expect(serialized).not.toContain(PRIV.fenceRow);
  });

  it('#4549 shape: remote delta never carries the private page title', async () => {
    const res = await sweepCall('delta', { since: SINCE_EPOCH }, 'scalar');
    const serialized = JSON.stringify(res);
    expect(res.isError ?? false).toBe(false);
    expect(serialized).not.toContain(PRIV.pageTitle);
  });

  it('federated arm actually spans source 2; scalar arm stays source-scoped (cross-source controls)', async () => {
    // Positive control: an allowedSources grant covering src2 must surface
    // src2's world page through a scoped listing op.
    const fed = await sweepCall('list_pages', {}, 'federated');
    expect(fed.isError ?? false).toBe(false);
    expect(JSON.stringify(fed)).toContain(WORLD.src2Page);
    // Isolation control: the scalar default-scoped shape must NOT see src2
    // data through a source-scoped op.
    const scalar = await sweepCall('list_pages', {}, 'scalar');
    expect(scalar.isError ?? false).toBe(false);
    expect(JSON.stringify(scalar)).not.toContain(WORLD.src2Page);
  });

  // Slug-class leaks are invisible to the sentinel assertion by design
  // (sentinels never live in slugs — legit "Page not found: <slug>" echoes
  // would false-positive). Ops that return slug LISTS derived from data
  // (not echoes of a requested slug) get targeted anchors instead.
  it('slug-list arms never name the private page slug (find_anomalies / find_orphans / list_pages / delta / salience)', async () => {
    for (const [op, params] of [
      ['find_anomalies', {}],
      ['find_orphans', {}],
      ['list_pages', {}],
      ['delta', { since: SINCE_EPOCH }],
      ['get_recent_salience', {}],
    ] as const) {
      for (const shape of ['scalar', 'federated'] as const) {
        const res = await sweepCall(op, params as Record<string, unknown>, shape);
        const serialized = JSON.stringify(res);
        expect(res.isError ?? false).toBe(false);
        // Non-emptiness proof: the absence assertion below means nothing
        // against an empty list, so each op must name at least one WORLD
        // slug from the corpus.
        if (!serialized.includes(WORLD_PAGE_SLUG) && !serialized.includes(WORLD_FENCE_SLUG)) {
          throw new Error(`slug-list anchor vacuous: op "${op}" [${shape}] named no world slug — corpus/threshold drift emptied the list.`);
        }
        if (serialized.includes(PRIV_PAGE_SLUG)) {
          throw new Error(`PRIVACY LEAK (slug-class): op "${op}" [${shape}] named the private page slug.`);
        }
      }
    }
  }, 30_000);
});
