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
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
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
    for (const op of operations) {
      if (op.mutating === true) {
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
});

describe('get_job/list_jobs redact protected-job payloads for remote callers (#2786 codex round 8)', () => {
  // Read-side counterpart to the submission-side PROTECTED_JOB_NAMES guard:
  // protecting SUBMISSION of a job kind stops an untrusted caller from
  // TRIGGERING it, but does nothing about a DIFFERENT untrusted caller
  // later reading back the `data`/`result` of a job a TRUSTED caller
  // legitimately submitted. chronicle_extract's mirror guard first
  // surfaced this (its result can reveal a hidden source's existence).
  //
  // codex review round 10 (P1): this was originally "general — applies to
  // every PROTECTED_JOB_NAMES entry," which broke the supported remote
  // `submit_agent` workflow (an OAuth agent/admin client submits a
  // `subagent` job over MCP and reads its result back via get_job — both
  // legitimately remote). The redaction now checks the narrower
  // CROSS_SOURCE_SENSITIVE_JOB_NAMES set instead; see the "does NOT redact
  // a cost-protected-but-not-leak-sensitive job" test below.
  async function submitProtectedJob(): Promise<number> {
    // resetPgliteState() (this file's shared beforeEach) TRUNCATEs the
    // `config` table along with everything else it doesn't explicitly
    // preserve — including the `version` key MinionQueue.ensureSchema()
    // reads to confirm the minion_jobs table is migrated in. The TABLE
    // itself survives (TRUNCATE empties rows, doesn't drop schema), only
    // the config row does not; restore it before touching the queue so
    // `queue.add()` doesn't see a false "unmigrated" state.
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    await engine.setConfig('version', String(LATEST_VERSION));
    const { MinionQueue } = await import('../src/core/minions/queue.ts');
    const queue = new MinionQueue(engine);
    const job = await queue.add(
      'chronicle_extract',
      { slug: 'meetings/secret-mirror-test', sourceId: 'default' },
      undefined,
      { allowProtectedSubmit: true },
    );
    // Stamp a completed-with-result state directly via SQL — exercising the
    // full claim/complete job lifecycle isn't the point of this test, only
    // that get_job/list_jobs redact whatever `data`/`result` a protected
    // job row carries. Raw object bind (not JSON.stringify) per the repo's
    // own JSONB rule (CLAUDE.md — postgres.js double-encodes a stringified
    // scalar into a jsonb string).
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', result = $1 WHERE id = $2`,
      [{ status: 'skipped', reason: 'mirrored_source_slug' }, job.id],
    );
    return job.id;
  }

  test('get_job redacts data + result of a protected job for ctx.remote=true', async () => {
    const id = await submitProtectedJob();

    const getJob = operations.find(op => op.name === 'get_job');
    const remoteResult = await getJob!.handler(makeContext({ remote: true }), { id });
    expect((remoteResult as { data: unknown }).data).toEqual({ redacted: true });
    expect((remoteResult as { result: unknown }).result).toEqual({ redacted: true });
  });

  test('get_job does NOT redact a protected job for ctx.remote=false (trusted local)', async () => {
    const id = await submitProtectedJob();

    const getJob = operations.find(op => op.name === 'get_job');
    const localResult = await getJob!.handler(makeContext({ remote: false }), { id });
    expect((localResult as { data: { slug: string } }).data.slug).toBe('meetings/secret-mirror-test');
    expect((localResult as { result: { reason: string } }).result?.reason).toBe('mirrored_source_slug');
  });

  test('get_job does NOT redact a NON-protected job for ctx.remote=true', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    await engine.setConfig('version', String(LATEST_VERSION));
    const { MinionQueue } = await import('../src/core/minions/queue.ts');
    const queue = new MinionQueue(engine);
    const job = await queue.add('enrich', { slug: 'wiki/some-page' });

    const getJob = operations.find(op => op.name === 'get_job');
    const remoteResult = await getJob!.handler(makeContext({ remote: true }), { id: job.id });
    expect((remoteResult as { data: { slug: string } }).data.slug).toBe('wiki/some-page');
  });

  test('list_jobs redacts protected jobs but leaves non-protected jobs visible for ctx.remote=true', async () => {
    const protectedId = await submitProtectedJob();
    const { MinionQueue } = await import('../src/core/minions/queue.ts');
    const queue = new MinionQueue(engine);
    const nonProtected = await queue.add('enrich', { slug: 'wiki/visible-page' });

    const listJobs = operations.find(op => op.name === 'list_jobs');
    const remoteResults = await listJobs!.handler(makeContext({ remote: true }), { limit: 50 }) as Array<{ id: number; data: Record<string, unknown> }>;

    const protectedRow = remoteResults.find(j => j.id === protectedId);
    const visibleRow = remoteResults.find(j => j.id === nonProtected.id);
    expect(protectedRow?.data).toEqual({ redacted: true });
    expect(visibleRow?.data?.slug).toBe('wiki/visible-page');
  });

  // codex review round 9 (P1): cancel_job/retry_job return the full job row
  // too — redacting only get_job/list_jobs left these two mutation
  // endpoints as an unpatched way to recover a protected job's data/result.
  test('cancel_job redacts data of a protected job for ctx.remote=true', async () => {
    // submitProtectedJob() stamps the job 'completed' (a terminal status
    // cancelJob refuses), so this test adds one directly and leaves it in
    // its default 'waiting' status instead.
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    await engine.setConfig('version', String(LATEST_VERSION));
    const { MinionQueue } = await import('../src/core/minions/queue.ts');
    const queue = new MinionQueue(engine);
    const job = await queue.add(
      'chronicle_extract',
      { slug: 'meetings/secret-mirror-test', sourceId: 'default' },
      undefined,
      { allowProtectedSubmit: true },
    );
    const id = job.id;

    const cancelJob = operations.find(op => op.name === 'cancel_job');
    const remoteResult = await cancelJob!.handler(makeContext({ remote: true }), { id });
    expect((remoteResult as { data: unknown }).data).toEqual({ redacted: true });
  });

  // codex review round 9 (P2): retryJob() has no PROTECTED_JOB_NAMES check
  // of its own (only add() does) — without a submit-time-equivalent guard
  // here, a remote admin token could re-trigger a failed/dead protected
  // job's LLM call / cross-source mirror lookup, bypassing the
  // submission-side trust guarantee entirely.
  test('retry_job rejects retrying a protected (failed) job for ctx.remote=true', async () => {
    const id = await submitProtectedJob();
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'failed' WHERE id = $1`, [id]);

    const retryJob = operations.find(op => op.name === 'retry_job');
    let threw = false;
    let message = '';
    try {
      await retryJob!.handler(makeContext({ remote: true }), { id });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw, 'retry_job on a protected job with remote=true MUST reject').toBe(true);
    expect(message.toLowerCase()).toContain('chronicle_extract');
  });

  test('retry_job allows retrying a protected (failed) job for ctx.remote=false (trusted local)', async () => {
    const id = await submitProtectedJob();
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'failed' WHERE id = $1`, [id]);

    const retryJob = operations.find(op => op.name === 'retry_job');
    const localResult = await retryJob!.handler(makeContext({ remote: false }), { id });
    expect((localResult as { data: { slug: string } }).data.slug).toBe('meetings/secret-mirror-test');
    expect((localResult as { status: string }).status).toBe('waiting');
  });

  // codex review round 10 (P1): a `subagent` job is submission-protected
  // (cost control — PROTECTED_JOB_NAMES) but NOT cross-source-sensitive,
  // so a remote caller that legitimately submitted one via `submit_agent`
  // must still be able to read its own result back.
  test('get_job does NOT redact a cost-protected-but-not-leak-sensitive job (subagent) for ctx.remote=true', async () => {
    const { LATEST_VERSION } = await import('../src/core/migrate.ts');
    await engine.setConfig('version', String(LATEST_VERSION));
    const { MinionQueue } = await import('../src/core/minions/queue.ts');
    const queue = new MinionQueue(engine);
    const job = await queue.add(
      'subagent',
      { prompt: 'summarize wiki/some-page' },
      undefined,
      { allowProtectedSubmit: true },
    );
    await engine.executeRaw(
      `UPDATE minion_jobs SET status = 'completed', result = $1 WHERE id = $2`,
      [{ output: 'summary text' }, job.id],
    );

    const getJob = operations.find(op => op.name === 'get_job');
    const remoteResult = await getJob!.handler(makeContext({ remote: true }), { id: job.id });
    expect((remoteResult as { result: { output: string } }).result?.output).toBe('summary text');
  });

  // codex review round 10 (P2): replayJob() re-submits via add(), which
  // rejects PROTECTED_JOB_NAMES without allowProtectedSubmit — mirrors the
  // retry_job trust gate above, applied to replay_job.
  test('replay_job rejects replaying a protected (failed) job for ctx.remote=true', async () => {
    const id = await submitProtectedJob();
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'failed' WHERE id = $1`, [id]);

    const replayJob = operations.find(op => op.name === 'replay_job');
    let threw = false;
    let message = '';
    try {
      await replayJob!.handler(makeContext({ remote: true }), { id });
    } catch (e) {
      threw = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(threw, 'replay_job on a protected job with remote=true MUST reject').toBe(true);
    expect(message.toLowerCase()).toContain('chronicle_extract');
  });

  test('replay_job allows replaying a protected (failed) job for ctx.remote=false (trusted local)', async () => {
    const id = await submitProtectedJob();
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'failed' WHERE id = $1`, [id]);

    const replayJob = operations.find(op => op.name === 'replay_job');
    const localResult = await replayJob!.handler(makeContext({ remote: false }), { id });
    expect((localResult as { name: string }).name).toBe('chronicle_extract');
    expect((localResult as { status: string }).status).toBe('waiting');
  });
});
