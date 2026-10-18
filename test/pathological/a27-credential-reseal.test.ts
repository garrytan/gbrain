/**
 * GBRA-130 A-27: the v0.60.31 orchestrated migration re-chunks every page whose
 * body holds a private key (src/core/page-state/credential-reseal.ts,
 * src/commands/migrations/v0_60_31.ts).
 *
 * Protects: one page whose credential-safe re-chunk throws item-scoped no
 * longer fails the phase (three partial runs wedge every apply-migrations and
 * upgrade): the page is recorded durably with its revision and error code, its
 * chunks stay withheld, every other page is re-chunked, the phase completes
 * with \`held: N\` in its detail, doctor text_projection_readiness lists the held
 * page with \`gbrain repair safe-chunks --source <id> --apply\`, that command
 * retries and seals it, and the record clears when the page changes. A
 * run-scoped failure still fails the phase, and so does a systemic run
 * (\`item_failures_systemic\`), recording nothing.
 * Fails when: one page's failure marks the phase failed again, the record
 * blocks or outlives its revision, or a run-scoped error is recorded as a hold.
 * Why new: test/e2e/credential-projection-repair.test.ts covers healthy pages.
 * Seams: __setTestEngineOverride (existing); a test-only trigger on
 * content_chunks builds the unbuildable page; run-scoped errors are injected at
 * the engine's transaction.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { readCredentialResealHolds } from '../../src/core/page-state/credential-reseal.ts';
import { v0_60_31, __setTestEngineOverride } from '../../src/commands/migrations/v0_60_31.ts';
import { checkProjectionReadiness } from '../../src/commands/doctor/checks/projection-readiness.ts';
import { credentialProjectionPendingCheck } from '../../src/commands/doctor/checks/credential-projection.ts';
import { resolveRepairScope, runRepair } from '../../src/core/repair/core.ts';
import { safeChunksRepair } from '../../src/core/repair/safe-chunks.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'default';
const SLUGS = ['ops/k1', 'ops/k2', 'ops/k3', 'ops/k4', 'ops/k5', 'ops/k6'];
const POISON = 'ops/k2';
const quiet = { info() {}, warn() {}, error() {} };
// Built at runtime so no key-shaped literal sits in the repository.
const pem = () => ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') + '\n' + randomBytes(48).toString('base64') + '\n' + ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
const body = (slug: string) => '---\ntitle: ' + slug + '\ntype: note\n---\n\nDeploy notes for ' + slug + '.\n\n' + pem() + '\n\nRotation steps follow.\n';

async function refuseChunks(engine: BrainEngine, slugs: string[]) {
  const ids = (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])', [SOURCE, slugs])).map(row => Number(row.id));
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION pathological_refuse_chunk() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN IF NEW.page_id = ANY(ARRAY[${ids.join(',')}]::int[]) THEN RAISE EXCEPTION 'pathological: chunk refused for this page' USING ERRCODE = 'check_violation'; END IF; RETURN NEW; END $fn$`);
  await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_chunk ON content_chunks');
  await engine.executeRaw('CREATE TRIGGER pathological_refuse_chunk BEFORE INSERT OR UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION pathological_refuse_chunk()');
}

function failingAt(engine: BrainEngine, injected: unknown): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'transaction' && typeof value === 'function') {
      return (...args: unknown[]) => new Error().stack?.includes('resealSafeChunks') ? Promise.reject(injected) : (value as Function).apply(target, args);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}

const migrate = () => v0_60_31.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe('A-27 v0.60.31 credential re-chunk: one unbuildable page never fails the migration (' + backend + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => { ({ engine, close } = await isolatedSharedSkillsEngine(databaseUrl)); }, 120_000);
    afterAll(async () => { await close(); });
    afterEach(() => { __setTestEngineOverride(null); });
    beforeEach(async () => {
      await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_chunk ON content_chunks');
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='credential-reseal-hold' OR op='repair'");
      await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [SOURCE]);
      for (const slug of SLUGS) await importFromContent(engine, slug, body(slug), { noEmbed: true, sourceId: SOURCE });
      // Schema migration v189's state: the pages' old chunks are withheld until the re-chunk seals them.
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE source_id=$1', [SOURCE]);
      await engine.executeRaw('DELETE FROM content_chunks WHERE page_id IN (SELECT id FROM pages WHERE source_id=$1)', [SOURCE]);
      __setTestEngineOverride(engine);
    });

    test('item case: the unbuildable page is held with its code and the migration completes; doctor lists it with the retry command', async () => {
      await refuseChunks(engine, [POISON]);
      const before = await snapshotItems(engine, SOURCE);
      const result = await expectUnitNotAborted(migrate);
      expect(result.status).toBe('complete');
      expect(result.phases[0]).toMatchObject({ name: 'credential_projection', status: 'complete' });
      expect(result.phases[0]!.detail).toContain('held: 1');
      expect(result.phases[0]!.detail).toContain('invalid_data');
      const holds = await readCredentialResealHolds(engine);
      expect(holds.length).toBe(1);
      expectItemFailure({ key: holds[0]!.source_id + ':' + holds[0]!.slug, code: holds[0]!.code, fix: holds[0]!.fix }, { key: SOURCE + ':' + POISON, code: 'invalid_data', fix: /"gbrain","repair","safe-chunks","--source","default","--apply"/ });
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: SLUGS.filter(s => s !== POISON), progressFields: ['chunks'] });
      const check = await checkProjectionReadiness(engine);
      expect(check.status).toBe('warn');
      expect(check.details).toMatchObject({ credential_reseal_held: 1, held_pages: [{ source_id: SOURCE, slug: POISON, code: 'invalid_data' }] });
      expect(check.message).toContain('gbrain repair safe-chunks --source default --apply');
      expect(check.fix?.argv).toEqual(['gbrain', 'repair', 'safe-chunks', '--source', SOURCE, '--apply']);
      const pending = await credentialProjectionPendingCheck(engine, [SOURCE]);
      expect(pending.details).toMatchObject({ pages_pending: 1, held_pages: 1 });
      expect(pending.message).toContain('gbrain repair safe-chunks --source default --apply');
      const remote = await checkProjectionReadiness(engine, {}, { remote: true });
      expect(JSON.stringify(remote)).not.toContain(POISON);
    });

    test('three consecutive runs on the same page all complete (never partial, so never wedged) and count the attempts', async () => {
      await refuseChunks(engine, [POISON]);
      for (let run = 1; run <= 3; run++) {
        const result = await expectUnitNotAborted(migrate);
        expect({ run, status: result.status, phase: result.phases[0]!.status }).toEqual({ run, status: 'complete', phase: 'complete' });
      }
      expect((await readCredentialResealHolds(engine)).map(h => [h.slug, h.attempts])).toEqual([[POISON, 3]]);
    });

    test('recovery case: once the page can be built, the doctor fix re-chunks it and the hold clears', async () => {
      await refuseChunks(engine, [POISON]);
      await expectUnitNotAborted(migrate);
      await engine.executeRaw('DROP TRIGGER IF EXISTS pathological_refuse_chunk ON content_chunks');
      const before = await snapshotItems(engine, SOURCE);
      const repair = await expectUnitNotAborted(async () => runRepair({ engine, sourceId: SOURCE, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: quiet } as never,
        safeChunksRepair, await resolveRepairScope(engine, SOURCE), { apply: true, embed: false }));
      expect(repair).toMatchObject({ applied: 1, complete: true });
      expect(await readCredentialResealHolds(engine)).toEqual([]);
      expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { expectProgress: [POISON], progressFields: ['chunks'] });
      expect((await checkProjectionReadiness(engine)).details).not.toHaveProperty('credential_reseal_held');
    });

    test('the hold clears when the page changes (a new revision is a new item)', async () => {
      await refuseChunks(engine, [POISON]);
      await expectUnitNotAborted(migrate);
      expect((await readCredentialResealHolds(engine)).length).toBe(1);
      await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id=$1 AND slug=$2', [SOURCE, POISON]);
      expect(await readCredentialResealHolds(engine)).toEqual([]);
    });

    for (const { name, error } of runScopedErrors()) {
      test('run case: a run-scoped ' + name + ' fails the phase and records no hold', async () => {
        __setTestEngineOverride(failingAt(engine, error()));
        const before = await snapshotItems(engine, SOURCE);
        const result = await migrate();
        expect(result.status).toBe('partial');
        expect(result.phases[0]!.status).toBe('failed');
        expect(await readCredentialResealHolds(engine)).toEqual([]);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE));
      });
    }

    test('breaker case: when every page fails the phase fails item_failures_systemic and records no hold', async () => {
      await refuseChunks(engine, SLUGS);
      const result = await migrate();
      expect(result.status).toBe('partial');
      expect(result.phases[0]!.status).toBe('failed');
      expect(result.phases[0]!.detail).toContain('item_failures_systemic');
      expect(await readCredentialResealHolds(engine)).toEqual([]);
    });
  });
}
