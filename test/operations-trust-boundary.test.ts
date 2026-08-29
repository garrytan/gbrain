/**
 * v0.39 trust-boundary contract test (GAP 3 of the e2e-test-wave audit).
 *
 * Hybrid design (D7 — pure + targeted handler invocation):
 *
 *   - Pure assertions over ALL operations (~74 ops): scope annotations
 *     present + correct; localOnly ops are filtered out of the canonical
 *     mcpOperations list; hasScope semantics work for the standard tiers.
 *
 *   - Handler-invocation cases for ops that are NOT localOnly but DO
 *     enforce remote/scope at the handler layer (defense-in-depth where
 *     it actually fires in production):
 *
 *       * submit_job   — name='shell' + ctx.remote=true MUST reject
 *                        (the HTTP MCP shell-job RCE class, F7b)
 *       * search_by_image — image_path + ctx.remote=true MUST reject
 *                        (D18 P0 source-isolation leak class)
 *
 *     `file_upload` and `sync_brain` are intentionally NOT in the
 *     handler-invocation set — both are localOnly, so the canonical
 *     filter removes them from mcpOperations and the HTTP path never
 *     reaches their handlers. Calling their handlers with remote=true
 *     tests an impossible production path (codex CMT-3). The defense-
 *     in-depth strict-mode checks inside those handlers still exist;
 *     they're proven by the localOnly-filtered-out contract here.
 *
 * Criterion for the curated sensitive-ops list:
 *   ops whose HANDLER (not transport) has been broken historically.
 *   Add an op here when a real exploit class is fixed at the handler
 *   level; remove only when the handler-level defense becomes
 *   structurally unreachable (e.g., the op becomes localOnly).
 *
 * Companion guard at scripts/check-operations-filter-bypass.sh enforces
 * the canonical filter site so a future HTTP route can't bypass it.
 *
 * Dynamic sibling: test/remote-privacy-sweep.test.ts — a corpus-seeded
 * sweep of EVERY non-localOnly op through dispatchToolCall asserting no
 * private-sentinel leakage (the #4546/#4549 read-leak class). This file
 * pins the static contract + curated handler probes; the sweep catches
 * leaks in ops neither file has heard of yet. Same doctrine, two layers.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { verbOperations } from '../src/core/verbs.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { hasScope } from '../src/core/scope.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// Minimal context factory — every test that invokes a handler builds
// one of these. Defaults to remote=true (untrusted) because that's the
// trust posture the bug-class regressions live in; tests opt back to
// local trust by overriding remote=false.
function makeContext(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

describe('operations contract — every op has scope + correct mutability shape', () => {
  test('every op declares a scope annotation', () => {
    for (const op of operations) {
      expect(op.scope, `op "${op.name}" missing scope annotation`).toBeDefined();
    }
  });

  test('every mutating op has a write-class scope (not "read")', () => {
    const WRITE_CLASS_SCOPES = new Set([
      'write',
      'admin',
      'sources_admin',
      'users_admin',
      'agent',
    ]);
    // Remote-gated exception (#2598, same allowlist as test/oauth.test.ts):
    // `think` is read-scoped for OAuth/MCP because its handler forces
    // save/take OFF for remote callers before persistence — pinned by
    // test/takes-mcp-allowlist.serial.test.ts. Local CLI can still persist.
    // WP4/D9: request_tools is read-scoped + mutating — its only write (the
    // {surface} persist branch) self-enforces the D2 ceiling, the operator
    // lock, and a per-client rate limit (test/request-tools.test.ts pins all
    // three); read scope keeps discovery available to every token class.
    const REMOTE_READ_ONLY_MUTATING_OPS = new Set(['think', 'request_tools']);
    for (const op of operations) {
      if (op.mutating === true) {
        if (REMOTE_READ_ONLY_MUTATING_OPS.has(op.name)) {
          expect(op.scope, `remote-gated mutating op "${op.name}" should be read-scoped`).toBe('read');
          continue;
        }
        expect(
          WRITE_CLASS_SCOPES.has(op.scope ?? 'read'),
          `mutating op "${op.name}" has read-tier scope "${op.scope}"; expected one of ${[...WRITE_CLASS_SCOPES].join('/')}`,
        ).toBe(true);
      }
    }
  });

  test('scope is one of the documented enum values', () => {
    const KNOWN_SCOPES = new Set([
      'read',
      'write',
      'admin',
      'sources_admin',
      'users_admin',
      'agent',
    ]);
    for (const op of operations) {
      expect(
        KNOWN_SCOPES.has(op.scope!),
        `op "${op.name}" has unknown scope "${op.scope}"`,
      ).toBe(true);
    }
  });

  test('state-changing job controls declare mutating metadata', () => {
    for (const name of ['pause_job', 'resume_job', 'replay_job', 'send_job_message']) {
      const op = operations.find(candidate => candidate.name === name);
      expect(op, `expected canonical op "${name}" to exist`).toBeDefined();
      expect(op!.mutating, `state-changing op "${name}" must declare mutating`).toBe(true);
    }
  });
});

describe('job-control operations — dry run never changes queue state', () => {
  test('pause_job previews without pausing, then a real call pauses', async () => {
    await engine.setConfig('version', '130');
    const queue = new MinionQueue(engine);
    const job = await queue.add('sync', {});
    const op = operations.find(candidate => candidate.name === 'pause_job')!;

    const preview = await op.handler(makeContext({ remote: false, dryRun: true }), { id: job.id });
    expect(preview).toEqual({ dry_run: true, action: 'pause_job', id: job.id });
    expect((await queue.getJob(job.id))!.status).toBe('waiting');

    const result = await op.handler(makeContext({ remote: false }), { id: job.id });
    expect(result).toEqual({ id: job.id, status: 'paused' });
    expect((await queue.getJob(job.id))!.status).toBe('paused');
  });

  test('resume_job previews without resuming, then a real call resumes', async () => {
    await engine.setConfig('version', '130');
    const queue = new MinionQueue(engine);
    const job = await queue.add('sync', {});
    await queue.pauseJob(job.id);
    const op = operations.find(candidate => candidate.name === 'resume_job')!;

    const preview = await op.handler(makeContext({ remote: false, dryRun: true }), { id: job.id });
    expect(preview).toEqual({ dry_run: true, action: 'resume_job', id: job.id });
    expect((await queue.getJob(job.id))!.status).toBe('paused');

    const result = await op.handler(makeContext({ remote: false }), { id: job.id });
    expect(result).toEqual({ id: job.id, status: 'waiting' });
    expect((await queue.getJob(job.id))!.status).toBe('waiting');
  });
});

describe('mcpOperations filter — localOnly ops are excluded from the HTTP-exposed surface', () => {
  // This filter is what serve-http.ts uses to build the tools/list response:
  //   const mcpOperations = operations.filter(op => !op.localOnly);
  // A localOnly op that leaks into mcpOperations is exposed via HTTP MCP
  // and bypasses the trust boundary. Pin the filter contract here so a
  // regression surfaces as a structural test failure.

  test('the canonical filter excludes every localOnly op', () => {
    const mcpOps = operations.filter(op => !op.localOnly);
    const mcpNames = new Set(mcpOps.map(op => op.name));
    const localOnlyOps = operations.filter(op => op.localOnly === true);

    expect(localOnlyOps.length).toBeGreaterThan(0);
    for (const op of localOnlyOps) {
      expect(
        mcpNames.has(op.name),
        `localOnly op "${op.name}" leaked into the HTTP MCP surface`,
      ).toBe(false);
    }
  });

  test('localOnly snapshot — derived list matches the pinned literal exactly', () => {
    // B3 (missing-test-coverage plan): replaces the old hand-rolled
    // KNOWN_LOCAL_ONLY array, which only caught DROPPED flags (a new
    // localOnly op could ship without ever being pinned — the original
    // 4-name list missed purge_deleted_pages, get_recent_transcripts, and
    // code_traversal_cache_clear for exactly that reason). Deriving the
    // list from the canonical op surface and pinning it against a sorted
    // literal catches BOTH directions:
    //   - an op silently sheds its localOnly flag → missing from derived;
    //   - a new localOnly op appears → extra in derived → the author must
    //     consciously add it here (and think about why it's localOnly).
    // When this fails: verify the change is intentional, then update the
    // literal in the same commit.
    const LOCAL_ONLY_SNAPSHOT = [
      'chronicle_backfill',
      'code_traversal_cache_clear',
      // v0.46.31.0 chat-connectors wave: both drive local connector CLIs +
      // filesystem state; remote callers get them via the CLI only.
      'connector_sync',
      'connectors_status',
      // v0.46.x identity wave: link/unlink rewrite identity rows brain-wide.
      'entity_identity_link',
      'entity_identity_unlink',
      'extraction_review',
      'file_list',
      'file_upload',
      'file_url',
      'get_recent_transcripts',
      'migrate_embeddings',
      'purge_deleted_pages',
      'sync_brain',
    ];
    const derived = operations.filter(o => o.localOnly).map(o => o.name).sort();
    expect(derived).toEqual(LOCAL_ONLY_SNAPSHOT);

    // Keep the old per-name consumption working: every pinned op still
    // exists in the canonical surface and still carries localOnly === true
    // (strict boolean — the filter above accepts truthy, the contract is
    // the literal `true`).
    const lookup = new Map(operations.map(op => [op.name, op] as const));
    for (const name of LOCAL_ONLY_SNAPSHOT) {
      const op = lookup.get(name);
      expect(op, `expected canonical op "${name}" to still exist`).toBeDefined();
      expect(op!.localOnly, `"${name}" must stay localOnly`).toBe(true);
    }
  });
});

describe('hasScope — read-only token cannot satisfy write or admin scopes', () => {
  // The HTTP path computes `requiredScope = op.scope || 'read'` and gates
  // every call on `hasScope(authInfo.scopes, requiredScope)`. Pin the
  // semantics here so a refactor of the IMPLIES table can't silently
  // grant admin via a read-class token.
  test('read scope does NOT satisfy write', () => {
    expect(hasScope(['read'], 'write')).toBe(false);
  });

  test('read scope does NOT satisfy admin', () => {
    expect(hasScope(['read'], 'admin')).toBe(false);
  });

  test('write scope satisfies write AND read', () => {
    expect(hasScope(['write'], 'write')).toBe(true);
    expect(hasScope(['write'], 'read')).toBe(true);
  });

  test('admin scope satisfies admin, write, AND read (umbrella implies)', () => {
    expect(hasScope(['admin'], 'admin')).toBe(true);
    expect(hasScope(['admin'], 'write')).toBe(true);
    expect(hasScope(['admin'], 'read')).toBe(true);
  });

  test('unknown scope strings are ignored, do not satisfy anything', () => {
    expect(hasScope(['bogus'], 'read')).toBe(false);
    expect(hasScope(['bogus'], 'write')).toBe(false);
  });

  test('every read-scope op accepts a read-only token; every write-scope op rejects it', () => {
    // Walk the op surface and assert that a synthetic read-only token
    // satisfies every read-scope op but no write/admin op.
    const READ_TOKEN_SCOPES = ['read'] as const;
    for (const op of operations) {
      const required = op.scope ?? 'read';
      const accepted = hasScope(READ_TOKEN_SCOPES, required);
      if (required === 'read') {
        expect(accepted, `read op "${op.name}" should accept read-only token`).toBe(true);
      } else {
        expect(accepted, `${required} op "${op.name}" must reject read-only token`).toBe(false);
      }
    }
  });
});

describe('handler invocation — historically-broken trust-boundary classes', () => {
  // The two non-localOnly ops whose handler-level defense fires in
  // production and has been broken historically (F7b HTTP MCP shell-job
  // RCE; D18 P0 image_path remote-leak). file_upload and sync_brain are
  // omitted because they're localOnly (codex CMT-3 — testing their
  // handlers with remote=true tests an impossible production path).

  test('submit_job rejects shell with ctx.remote=true (HTTP MCP shell-job RCE class)', async () => {
    const submitJob = operations.find(op => op.name === 'submit_job');
    expect(submitJob).toBeDefined();
    const ctx = makeContext({ remote: true });

    let threw = false;
    let message = '';
    try {
      await submitJob!.handler(ctx, { name: 'shell', data: { cmd: 'echo hi' } });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw, 'submit_job(shell) with remote=true MUST reject').toBe(true);
    // Should mention the protected status — "permission_denied" is the
    // canonical OperationError code, plus the user-facing string names
    // the rejected name.
    expect(message.toLowerCase()).toContain('shell');
  });

  test('submit_job allows shell when ctx.remote=false (local CLI is trusted)', async () => {
    // The flip side of the trust boundary: a local trusted caller with
    // explicit remote=false MUST be allowed to submit shell jobs (that's
    // how the CLI works in production). We don't actually want to run the
    // job — pass dryRun so the op short-circuits.
    const submitJob = operations.find(op => op.name === 'submit_job');
    const ctx = makeContext({ remote: false, dryRun: true });

    const result = await submitJob!.handler(ctx, { name: 'shell', data: { cmd: 'echo hi' } });
    expect(result).toMatchObject({ dry_run: true, action: 'submit_job', name: 'shell' });
  });

  test('search_by_image rejects image_path with ctx.remote=true (D18 P0)', async () => {
    const searchByImage = operations.find(op => op.name === 'search_by_image');
    expect(searchByImage).toBeDefined();
    const ctx = makeContext({ remote: true });

    let threw = false;
    let message = '';
    try {
      await searchByImage!.handler(ctx, { image_path: '/tmp/some-image.png' });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw, 'search_by_image(image_path) with remote=true MUST reject').toBe(true);
    expect(message.toLowerCase()).toContain('image_path');
    expect(message.toLowerCase()).toContain('permission_denied');
  });

  test('find_orphans / get_recent_salience / find_anomalies hide private pages from remote callers (read-leak class)', async () => {
    // Admission per the curated-list criterion: a real exploit class fixed
    // at the handler level — remote callers received private page
    // slugs/titles/metadata through these list arms (found by the
    // remote-privacy-sweep on its first run; same class as the delta page
    // arm). Local trusted callers keep the unfiltered view.
    //
    // Two extra WORLD person pages make the corpus 3 same-type pages today:
    // enough for the anomaly type-cohort to FIRE (count > mean + 1 over an
    // empty baseline), so the find_anomalies assertions below are proven
    // non-vacuous by a LOCAL positive control instead of leaning on an
    // empty result.
    const put = operations.find(op => op.name === 'put_page')!;
    const local = makeContext({ remote: false });
    await put.handler(local, {
      slug: 'people/tb-priv-example',
      content: '---\ntitle: TB_PRIVATE_TITLE_PROOF\ntype: person\nvisibility: private\n---\n\n# TB_PRIVATE_TITLE_PROOF\n\nprivate body\n',
    });
    await put.handler(local, {
      slug: 'people/tb-world-a',
      content: '---\ntitle: TB World A\ntype: person\n---\n\n# TB World A\n\nworld body\n',
    });
    await put.handler(local, {
      slug: 'people/tb-world-b',
      content: '---\ntitle: TB World B\ntype: person\n---\n\n# TB World B\n\nworld body\n',
    });
    const remote = makeContext({ remote: true });

    type OrphanCounts = {
      orphans: { slug: string }[];
      total_orphans: number;
      total_pages: number;
      total_linkable: number;
      excluded: number;
    };
    const orphans = operations.find(op => op.name === 'find_orphans')!;
    const orphanResult = (await orphans.handler(remote, {})) as OrphanCounts;
    const orphanRes = JSON.stringify(orphanResult);
    expect(orphanRes).not.toContain('people/tb-priv-example');
    expect(orphanRes).not.toContain('TB_PRIVATE_TITLE_PROOF');
    // Count self-consistency after filtering: total_orphans mirrors the
    // filtered list (a stale unfiltered total is a hidden-page count oracle).
    expect(orphanResult.total_orphans).toBe(orphanResult.orphans.length);
    const orphanLocalResult = (await orphans.handler(local, {})) as OrphanCounts;
    const orphanLocal = JSON.stringify(orphanLocalResult);
    expect(orphanLocal).toContain('people/tb-priv-example');
    // Hidden orphans VANISH from every published counter: both denominators
    // shrink by the one hidden page and `excluded` is untouched — folding
    // hidden rows into `excluded` would be an exact one-call oracle, since
    // the unfiltered op guarantees excluded counts only pseudo-pages.
    expect(orphanLocalResult.total_pages - orphanResult.total_pages).toBe(1);
    expect(orphanLocalResult.total_linkable - orphanResult.total_linkable).toBe(1);
    expect(orphanResult.excluded).toBe(orphanLocalResult.excluded);

    const salience = operations.find(op => op.name === 'get_recent_salience')!;
    const salienceRes = JSON.stringify(await salience.handler(remote, {}));
    expect(salienceRes).not.toContain('people/tb-priv-example');
    expect(salienceRes).not.toContain('TB_PRIVATE_TITLE_PROOF');
    const salienceLocal = JSON.stringify(await salience.handler(local, {}));
    expect(salienceLocal).toContain('people/tb-priv-example');

    const anomalies = operations.find(op => op.name === 'find_anomalies')!;
    // LOCAL positive control: the person-type cohort anomaly fires and
    // names the private slug — proving the remote assertions below are
    // exercising a real filter, not an empty list.
    const anomaliesLocal = JSON.stringify(await anomalies.handler(local, {}));
    expect(anomaliesLocal).toContain('people/tb-priv-example');
    const anomalyRows = (await anomalies.handler(remote, {})) as {
      count: number;
      page_slugs: string[];
    }[];
    const anomaliesRes = JSON.stringify(anomalyRows);
    expect(anomaliesRes).not.toContain('people/tb-priv-example');
    expect(anomaliesRes).toContain('people/tb-world-a'); // non-empty proof
    for (const row of anomalyRows) {
      // No empty-row oracle, and for this sub-cap corpus the adjusted count
      // (original minus removed private slugs) equals the visible list —
      // a stale unadjusted count would read 3 here and leak the hidden
      // page's existence.
      expect(row.page_slugs.length).toBeGreaterThan(0);
      expect(row.count).toBe(row.page_slugs.length);
    }

    // find_experts: query the private page's OWN title so the expertise
    // scorer must rank it if it can see it — a remote caller gets nothing,
    // a local caller gets the row (deterministic, unlike fuzzy-threshold
    // sweep topics).
    const experts = operations.find(op => op.name === 'find_experts')!;
    const expertsRes = JSON.stringify(
      await experts.handler(remote, { topic: 'TB_PRIVATE_TITLE_PROOF' }),
    );
    expect(expertsRes).not.toContain('people/tb-priv-example');
    expect(expertsRes).not.toContain('TB_PRIVATE_TITLE_PROOF');
    const expertsLocal = JSON.stringify(
      await experts.handler(local, { topic: 'TB_PRIVATE_TITLE_PROOF' }),
    );
    expect(expertsLocal).toContain('people/tb-priv-example');

    // Soft-delete bypass (fail-closed probe): the raw salience/anomaly
    // queries carry no deleted_at predicate, so a soft-deleted private page
    // still reaches the handler rows — the post-filter must classify it
    // private-only via includeDeleted:true or it slips through.
    const del = operations.find(op => op.name === 'delete_page')!;
    await del.handler(local, { slug: 'people/tb-priv-example' });
    const salienceAfterDelete = JSON.stringify(await salience.handler(remote, {}));
    expect(salienceAfterDelete).not.toContain('people/tb-priv-example');
    expect(salienceAfterDelete).not.toContain('TB_PRIVATE_TITLE_PROOF');
    const anomaliesAfterDelete = JSON.stringify(await anomalies.handler(remote, {}));
    expect(anomaliesAfterDelete).not.toContain('people/tb-priv-example');
  });
});

describe('ops-module system-access containment — top-level fs/child_process importers only contribute localOnly ops', () => {
  // B3 inverse assertion: an ops module that statically imports the
  // filesystem or process-spawning APIs is a module whose op handlers can
  // plausibly touch the host — those ops must not be reachable over the
  // remote MCP surface unless someone consciously exempts them.
  //
  // GRANULARITY (the closest enforceable version of the file→ops mapping):
  //   - DETECTION is per-FILE and text-based: a static top-level ESM
  //     import/re-export of 'fs' / 'fs/promises' / 'child_process' (with or
  //     without the node: prefix). Static import statements are top-level by
  //     ESM grammar, so matching the `from '<specifier>'` clause is exact.
  //     Lazy dynamic `await import('node:fs')` INSIDE a handler is
  //     deliberately out of scope (schema-packs.ts and skillopt.ts use that
  //     form today) — it is runtime-gated per call site, the same doctrine
  //     as the engine-dynamic-import rule in CLAUDE.md.
  //   - ENFORCEMENT is per-OP: every canonical op a flagged file exports
  //     must be localOnly === true or appear in EXEMPT below. A mixed file
  //     (fs import serving one localOnly op alongside safe remote ops) is
  //     therefore judged op by op, not condemned wholesale.
  //   - EXEMPTION is keyed by op NAME, not (file, op) pair. Op names are
  //     globally unique in the canonical surface (operationsByName), so this
  //     is equivalent in practice and survives ops moving between modules.
  //   - A flagged HELPER module that exports no ops (context.ts today: its
  //     lstatSync/realpathSync import backs validateUploadPath, whose strict
  //     confinement serves the localOnly file_upload path) passes vacuously —
  //     the enforcement unit is the contributed op, and a helper contributes
  //     none.
  //
  // EXEMPT allowlist — op name → one-line rationale. Seeded from today's
  // scan, which flags only context.ts (zero contributed ops), so the seed is
  // EMPTY. Adding an entry is a conscious security decision: verify the op's
  // handler never lets a remote caller reach the fs/child_process surface
  // before exempting it.
  const EXEMPT: ReadonlyMap<string, string> = new Map<string, string>([
    // (empty today — no flagged module contributes a non-localOnly op)
  ]);

  const OPS_DIR = join(import.meta.dir, '..', 'src', 'core', 'ops');
  const opsFiles = readdirSync(OPS_DIR).filter(f => f.endsWith('.ts')).sort();

  // Matches static top-level `import ... from 'fs'` / `export ... from
  // 'node:child_process'` / side-effect `import 'node:fs'` forms. Does NOT
  // match dynamic `await import('node:fs')` (no `from` clause, no leading
  // import keyword at a line start) or commented-out imports (`//` and `*`
  // are not whitespace, so the line-start anchor excludes them).
  const SYSTEM_IMPORT_RE =
    /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\bfrom\s+)?['"](?:node:)?(?:fs|fs\/promises|child_process)['"]/;

  /**
   * Canonical ops contributed by one ops module: import it, walk every
   * export (flattening exported Operation[] arrays and individual Operation
   * exports like insights.ts's), keep objects shaped like an Operation whose
   * name is in the canonical `operations` list.
   */
  async function contributedOps(file: string): Promise<string[]> {
    const canonical = new Set(operations.map(o => o.name));
    const mod = await import(join(OPS_DIR, file));
    const found = new Set<string>();
    for (const value of Object.values(mod as Record<string, unknown>)) {
      const candidates = Array.isArray(value) ? value : [value];
      for (const c of candidates) {
        if (
          c !== null &&
          typeof c === 'object' &&
          typeof (c as { name?: unknown }).name === 'string' &&
          typeof (c as { handler?: unknown }).handler === 'function' &&
          canonical.has((c as { name: string }).name)
        ) {
          found.add((c as { name: string }).name);
        }
      }
    }
    return [...found].sort();
  }

  test('detector self-test — static top-level forms match, dynamic/commented forms do not', () => {
    // Guards the main test against a vacuous pass if the regex rots.
    expect(SYSTEM_IMPORT_RE.test(`import { readFileSync } from 'node:fs';`)).toBe(true);
    expect(SYSTEM_IMPORT_RE.test(`import { lstatSync, realpathSync } from 'fs';`)).toBe(true);
    expect(SYSTEM_IMPORT_RE.test(`import cp from 'child_process';`)).toBe(true);
    expect(SYSTEM_IMPORT_RE.test(`import {\n  readFileSync,\n  writeFileSync,\n} from 'fs/promises';`)).toBe(true);
    expect(SYSTEM_IMPORT_RE.test(`import 'node:fs';`)).toBe(true);
    expect(SYSTEM_IMPORT_RE.test(`export { execSync } from 'node:child_process';`)).toBe(true);
    expect(SYSTEM_IMPORT_RE.test(`const nodeFs = await import('node:fs');`)).toBe(false);
    expect(SYSTEM_IMPORT_RE.test(`import { resolve } from 'node:path';`)).toBe(false);
    expect(SYSTEM_IMPORT_RE.test(`code();\n// import { x } from 'node:fs'`)).toBe(false);
    expect(SYSTEM_IMPORT_RE.test(`import { x } from './fs-helpers.ts';`)).toBe(false);
  });

  test('export walk attributes the full canonical surface (guard against a vacuous pass)', async () => {
    // If the Operation-shape walk silently broke (returned nothing), the
    // containment test below would pass vacuously. Pin the mechanism: every
    // canonical op is either exported by some src/core/ops/*.ts module or is
    // one of the memory verbs from src/core/verbs.ts — nothing else.
    expect(opsFiles).toContain('files.ts');
    expect(opsFiles).toContain('jobs.ts');
    expect(await contributedOps('files.ts')).toEqual(['file_list', 'file_upload', 'file_url']);
    expect(await contributedOps('jobs.ts')).toContain('submit_job');

    const attributed = new Set<string>(verbOperations.map(op => op.name));
    for (const file of opsFiles) {
      for (const name of await contributedOps(file)) attributed.add(name);
    }
    expect([...attributed].sort()).toEqual(operations.map(o => o.name).sort());
  });

  test('every op contributed by a flagged module is localOnly or explicitly exempt', async () => {
    const byName = new Map(operations.map(op => [op.name, op] as const));
    const flagged = opsFiles.filter(f =>
      SYSTEM_IMPORT_RE.test(readFileSync(join(OPS_DIR, f), 'utf8')),
    );

    for (const file of flagged) {
      for (const opName of await contributedOps(file)) {
        const op = byName.get(opName)!;
        if (op.localOnly === true) continue;
        expect(
          EXEMPT.has(opName),
          `src/core/ops/${file} has a top-level fs/child_process import but contributes ` +
            `non-localOnly op "${opName}" — make the op localOnly, move the system import ` +
            `behind a lazy per-call dynamic import, or add an EXEMPT entry with a rationale ` +
            `after verifying remote callers cannot reach the fs/child_process surface`,
        ).toBe(true);
      }
    }

    // Exempt-list hygiene, fail-closed both ways: an entry for an op that no
    // longer exists (or is now localOnly, making the exemption dead) must be
    // removed so the allowlist stays small and every entry stays load-bearing.
    for (const [name] of EXEMPT) {
      const op = byName.get(name);
      expect(op, `EXEMPT entry "${name}" names an op that no longer exists — remove it`).toBeDefined();
      expect(
        op!.localOnly !== true,
        `EXEMPT entry "${name}" is now localOnly — the exemption is dead, remove it`,
      ).toBe(true);
    }
  });
});
