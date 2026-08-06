/**
 * #1575 — the unify-types WORKER registration defaulted `apply` to true,
 * while the handler interface documents "Default false (dry-run)". The
 * canonical operator invocation —
 *   gbrain jobs submit unify-types --allow-protected --params '{"target_pack":"X"}'
 * — therefore applied a one-shot destructive taxonomy migration on first
 * invocation, with no dry-run checkpoint.
 *
 * Behavioral pin: invoking the registered worker handler with job.data that
 * omits `apply` runs a DRY-RUN (no page mutation, active pack not flipped).
 * Consented apply paths pass `apply: true` explicitly (onboard remediation +
 * the printed migration command carry it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  _resetPackCacheForTests();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('unify-types worker default (#1575)', () => {
  it('omitting apply in job.data runs a dry-run, not a destructive apply', async () => {
    await engine.putPage('tweets/default-check', {
      title: 'tweets/default-check',
      type: 'tweet-single' as never,
      compiled_truth: 'body that is sufficiently long for any backstop guards we have in the codebase',
      timeline: '',
      frontmatter: {},
      source_path: 'tweets/default-check.md',
    });

    const worker = new MinionWorker(engine, { concurrency: 1 });
    await registerBuiltinHandlers(worker, engine);
    const handler = (worker as unknown as {
      handlers: Map<string, (j: unknown) => Promise<unknown>>;
    }).handlers.get('unify-types');
    if (!handler) throw new Error('unify-types handler not registered');

    const result = (await handler({
      id: 1,
      data: { target_pack: 'gbrain-base-v2' },  // no `apply` — the #1575 trap
      updateProgress: async () => {},
    })) as { apply: boolean; active_pack_flipped: boolean };

    // Handler interface: "Apply mutations. Default false (dry-run)."
    expect(result.apply).toBe(false);
    expect(result.active_pack_flipped).toBe(false);

    // The page was NOT retyped.
    const rows = await engine.executeRaw<{ type: string }>(
      `SELECT type FROM pages WHERE slug = 'tweets/default-check'`,
    );
    expect(rows[0]!.type).toBe('tweet-single');
  }, 60_000);
});
