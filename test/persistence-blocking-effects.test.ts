import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { WRITER_INSPECTION_HINT } from '../src/core/persistence/admin-intent.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { listBlockingEffects } from '../src/core/persistence/blocking-effects.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { freshBrainFactory, requestFixture } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;
for (const kind of testBackends()) {
  describe(`writer_not_quiesced names its blocker ${kind}`, () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let scratch: string;
    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'gbrain-blocking-effects-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    });
    const check = (name: string, fn: (engine: BrainEngine, root: string) => Promise<void>) => test(name, async () => {
      const engine = await factory.fresh();
      const home = mkdtempSync(join(scratch, 'home-'));
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const root = join(home, 'canonical'); mkdirSync(root);
        writeFileSync(join(root, 'example.md'), 'generic example');
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        try { await fn(engine, root); } finally { await disposePersistenceConsumer(engine); }
      });
    }, 120_000);

    check('a stuck queued embedding effect is named in the refusal and in writer status', async (engine, root) => {
      await claimWorktree(engine, 'default', root);
      const requests = await requestFixture(engine, 'effects-example');
      const published = await requests.publish(await requests.admit('notes/stuck'));
      const [effect] = await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_effects SET state='committed' WHERE request_id=$1::uuid AND kind<>'embedding'", [published.id]);
        return tx.executeRaw<{ id: string }>(`UPDATE persistence_effects SET next_attempt_at=now()+interval '30 days'
          WHERE request_id=$1::uuid AND kind='embedding' AND state='queued' RETURNING id::text AS id`, [published.id]);
      });
      expect(effect).toBeDefined();

      const error = await activateSharedSkillPersistence(engine, { confirmQuiesced: true }).then(() => null, failure => failure as { code: string; suggestion: string });
      expect(error?.code).toBe('writer_not_quiesced');
      const suggestion = error!.suggestion;
      expect(suggestion.startsWith(WRITER_INSPECTION_HINT)).toBe(true);
      expect(suggestion).toContain(`Blocking effect ${effect.id} (kind embedding, state queued) for source effects-example, page notes/stuck, request ${published.request_id}.`);
      expect(suggestion).toContain('Inspect it with: gbrain sources writer status effects-example --json.');
      expect(suggestion).toContain('gbrain repair embedding-effects --source effects-example (preview first, then --apply)');

      const expected = { effect_id: effect.id, kind: 'embedding', state: 'queued', recovering: false, source_id: 'effects-example',
        slug: 'notes/stuck', request_id: published.request_id, inspect: 'gbrain sources writer status effects-example --json' };
      expect(await listBlockingEffects(engine, { sourceId: 'effects-example', limit: 5 })).toEqual([expect.objectContaining(expected)]);
      expect(await listBlockingEffects(engine, { sourceId: 'default' })).toEqual([]);
      const status = await runPersistenceAdministration(engine, 'writer_status', {});
      expect(status.blocking_effects).toEqual([expect.objectContaining(expected)]);
      const scoped = await runPersistenceAdministration(engine, 'writer_status', { source_id: 'effects-example' });
      expect(scoped.blocking_effects).toEqual([expect.objectContaining(expected)]);
    });

    check('base activation names the queued request that blocks it', async (engine, root) => {
      await claimWorktree(engine, 'default', root);
      const requests = await requestFixture(engine, 'queued-example');
      const admitted = await requests.admit('notes/queued');
      const error = await activatePersistence(engine, { confirmQuiesced: true }).then(() => null, failure => failure as { code: string; suggestion: string });
      expect(error?.code).toBe('writer_not_quiesced');
      expect(error!.suggestion.startsWith(WRITER_INSPECTION_HINT)).toBe(true);
      expect(error!.suggestion).toContain(`Blocking request ${admitted.request_id} (put_page, queued) for source queued-example, page notes/queued.`);
      expect(error!.suggestion).toContain('Inspect it with: gbrain sources writer status queued-example --json.');
    });
  });
}
