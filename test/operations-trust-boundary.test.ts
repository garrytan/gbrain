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
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
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

  test('known historically-sensitive localOnly ops stay filtered', () => {
    // Pin every localOnly op by name so a refactor that flips localOnly off
    // on any of them fails this test even if the generic contract above
    // somehow regresses. Codex /ship review caught the original 4-name
    // snapshot was missing purge_deleted_pages, get_recent_transcripts, and
    // code_traversal_cache_clear — additions that already qualified.
    //
    // When adding a NEW localOnly op: add its name here too. The generic
    // contract above proves the filter rule applies; this list proves the
    // specific ops we care about haven't silently shed their localOnly flag.
    const KNOWN_LOCAL_ONLY = [
      'sync_brain',
      'file_upload',
      'file_list',
      'file_url',
      'purge_deleted_pages',
      'get_recent_transcripts',
      'code_traversal_cache_clear',
      'migrate_embeddings',
    ];
    const lookup = new Map(operations.map(op => [op.name, op] as const));
    for (const name of KNOWN_LOCAL_ONLY) {
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
