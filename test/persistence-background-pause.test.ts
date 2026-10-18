/**
 * #6696 (A5): near a cumulative cap a background admission refuses
 * `write_capacity_backpressure` before any receipt exists, while an
 * interactive admission keeps the rest; a surrounding background scope wins
 * over an inner interactive caller; one config key sets the line; doctor
 * names the paused producers. Both backends.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWriteGroupInTransaction } from '../src/core/persistence/journal.ts';
import { BACKGROUND_PAUSE_KEY, BACKGROUND_PRODUCERS, readBackgroundPauseShare, resolveAdmissionOrigin, withAdmissionOrigin } from '../src/core/persistence/admission-origin.ts';
import { checkPersistenceCapacity } from '../src/commands/doctor/checks/persistence-capacity.ts';
import { CODES } from '../src/core/error-registry.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const count = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM persistence_requests'))[0]!.n);
const lifetime = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: string }>(
  "SELECT lifetime_ids::text AS n FROM persistence_counters WHERE key LIKE 'principal:%'"))[0]!.n);

test('a surrounding background scope wins; unset is background', () => {
  expect(resolveAdmissionOrigin()).toBe('background');
  expect(resolveAdmissionOrigin('interactive')).toBe('interactive');
  expect(withAdmissionOrigin('interactive', () => resolveAdmissionOrigin())).toBe('interactive');
  expect(withAdmissionOrigin('background', () => resolveAdmissionOrigin('interactive'))).toBe('background');
  expect(withAdmissionOrigin('background', () => withAdmissionOrigin('interactive', () => resolveAdmissionOrigin('interactive')))).toBe('background');
});

for (const kind of testBackends()) {
  describe(`background pause ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-pause-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: scratch, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(engine));
    }, 120_000);

    check('the pause line reads as a percent, a share reads the same, and an invalid value keeps the default', async engine => {
      expect(await readBackgroundPauseShare(engine)).toBe(0.8);
      for (const [value, share] of [['90', 0.9], ['0.6', 0.6], ['100', 1], ['1', 1], ['0', 0.8], ['250', 0.8], ['abc', 0.8]] as const) {
        await engine.setConfig(BACKGROUND_PAUSE_KEY, value);
        expect(await readBackgroundPauseShare(engine)).toBe(share);
      }
    });

    check('a background admission past the line refuses with no receipt; an interactive one is admitted', async engine => {
      const requests = await requestFixture(engine);
      for (let i = 0; i < 3; i++) await requests.admit(`p${i}`);
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '5');
      await engine.setConfig(BACKGROUND_PAUSE_KEY, '0.6');
      const before = await count(engine);
      const refusal = await requests.admit('p3').then(() => null, error => error);
      expect(refusal).toMatchObject({ code: 'write_capacity_backpressure', reason: 'lifetime_ids', detail: 'principal_lifetime_ids' });
      expect(CODES.write_capacity_backpressure).toMatchObject({ class: 'host_only', retryable: false });
      expect(refusal.message).toContain('60% pause line');
      expect(await count(engine)).toBe(before);
      expect(await lifetime(engine)).toBe(3);
      // The same admission under the user's own origin keeps the rest.
      const admitted = await withAdmissionOrigin('interactive', () => requests.admit('p3'));
      expect(admitted.slug).toBe('p3');
      expect(await lifetime(engine)).toBe(4);
      // An interactive caller inside a background scope stays background.
      const scoped = await withAdmissionOrigin('background', () => withAdmissionOrigin('interactive', () => requests.admit('p4'))).then(() => null, error => error);
      expect(scoped).toMatchObject({ code: 'write_capacity_backpressure' });
      // Raising the line to the cap lifts the pause; the cap itself still answers write_quota_exhausted.
      await engine.setConfig(BACKGROUND_PAUSE_KEY, '1');
      await requests.admit('p4');
      expect(await requests.admit('p5').then(() => null, error => error)).toMatchObject({ code: 'write_quota_exhausted' });
    });

    check('a background group admission counts every fresh member against the line', async engine => {
      const requests = await requestFixture(engine);
      await requests.admit('g0');
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '10');
      await engine.setConfig(BACKGROUND_PAUSE_KEY, '0.5');
      const members = async (n: number) => Promise.all(Array.from({ length: n }, async (_, i) => {
        const slug = `g-${i}-${randomUUID()}`;
        const authority = await submissionAuthority(requests.ctx, 'put_page', requests.sourceId, requests.incarnation, slug);
        return { principal: authority.principal, authority, operation: 'put_page', sourceId: requests.sourceId, sourceIncarnation: requests.incarnation,
          slug, requestId: randomUUID(), callerIntent: { body: slug }, intent: { body: slug } };
      }));
      const five = await members(5), four = await members(4);
      const refusal = await engine.transaction(tx => admitWriteGroupInTransaction(tx, five)).then(() => null, error => error);
      expect(refusal).toMatchObject({ code: 'write_capacity_backpressure', reason: 'lifetime_ids' });
      expect(await lifetime(engine)).toBe(1);
      const admitted = await engine.transaction(tx => admitWriteGroupInTransaction(tx, four));
      expect(admitted).toHaveLength(4);
      expect(await lifetime(engine)).toBe(5);
    });

    check('doctor names the paused producers once a scope passes the line, and a fresh brain stays ok', async engine => {
      expect(await checkPersistenceCapacity(engine)).toMatchObject({ status: 'ok', details: { paused_producers: [] } });
      const requests = await requestFixture(engine);
      for (let i = 0; i < 4; i++) await requests.admit(`d${i}`);
      await engine.setConfig('persistence.capacity.warn_days', '0'); await engine.setConfig('persistence.capacity.fail_days', '0');
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '100');
      await engine.setConfig(BACKGROUND_PAUSE_KEY, '0.03');
      const paused = await checkPersistenceCapacity(engine);
      expect(paused.status).toBe('warn');
      expect(paused.details).toMatchObject({ background_pause_pct: 3, paused_producers: [...BACKGROUND_PRODUCERS] });
      expect(paused.message).toContain('Background writes are paused past 3%');
      expect(paused.message).toContain('write_capacity_backpressure');
    });
  });
}
