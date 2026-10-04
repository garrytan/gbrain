/**
 * Fix wave 3 timed recovery run: from an upgraded brain carrying every wave
 * finding (Lane D's fixture plus a connector source re-walking once after the
 * checkpoint migration, an orphan connector checkpoint and a page awaiting the
 * contextual-mode stamp), count the operator commands from `gbrain
 * post-upgrade` to a `--remediation-plan` with no repairable finding. PGLite
 * here; Postgres through test/e2e/fix-wave-3-integration.test.ts.
 *
 * Authoring gate. (1) Protects the upgrade promise: at most 3 commands, every
 * repair kind the wave added reached through the banner and one agreed run,
 * inside a 5-minute CI ceiling (a hang detector; wall time is reported, not
 * gated). (2) Fails when a new repair kind is missing from the remediation run,
 * when the banner omits the connector re-walk or a wave finding, or when a
 * repairable finding survives the agreed run. (3) test/recovery-layer.test.ts
 * measures the same path over Lane D's three kinds only. (4) No seam.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { migrateConnectorCheckpoints } from '../src/core/persistence/connector-checkpoint-migration.ts';
import { readConnectorSourceStatuses } from '../src/core/persistence/connector-status.ts';
import { runRemediate, runRemediationPlan } from '../src/commands/doctor/remediate.ts';
import { approvedRemediateArgs } from './helpers/remediate-approval.ts';
import { postUpgradeRecoveryBanner } from '../src/commands/doctor/upgrade-banner.ts';
import { capture } from './helpers/wave-scenarios.ts';
import { waveBrain } from './helpers/wave-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { options, json, googleConfig, contact, withGoogleAccount } from './helpers/connector-fixture.ts';

const VECTOR = `[${Array(1536).fill(0.01).join(',')}]`;

/** After the migration: a connector source whose newest pre-upgrade checkpoint receipt was compacted re-walks once. */
async function rewalkingConnector(engine: BrainEngine): Promise<string> {
  const id = `connector-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const dir = join(process.env.GBRAIN_HOME!, id);
  mkdirSync(dir);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, JSON.stringify(googleConfig)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const fetcher = async (url: string) => url.includes('/settings/sendAs') ? json({ sendAs: [] }) : json({ connections: [contact('first', 'First Example')], nextSyncToken: 'contacts-stable' });
  await runGoogleSync(engine, id, parseGoogleSourceConfig(googleConfig, dir), options, withGoogleAccount(fetcher));
  await disposePersistenceConsumer(engine);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op IN ('managed-connector','managed-connector-state')");
  const [template] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='connector_v2_checkpoint' ORDER BY sequence DESC LIMIT 1", [id]);
  const intent = { ...template!.intent, kind: 'managed_connector_checkpoint', checkpointKey: `legacy-${randomUUID()}`, configHash: 'legacy-raw-config-hash' };
  const row = await admitWrite(engine, { requestId: randomUUID(), operation: 'submit_job', sourceId: id, sourceIncarnation: template!.source_incarnation,
    slug: template!.slug, pageId: null, principal: { kind: template!.principal_kind, id: template!.principal_id }, authority: template!.authority, callerIntent: intent, intent } as never);
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw(`UPDATE persistence_requests SET state='committed',completed_at=now(),outcome='{"status":"checkpointed"}'::jsonb,compacted=true,intent=NULL WHERE id=$1::uuid`, [row.id]);
  });
  expect((await migrateConnectorCheckpoints(engine, () => {})).rewalking).toEqual([id]);
  // An orphan checkpoint left by a pre-upgrade binary, older than the 7-day floor.
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('managed-connector',$1,'[]'::jsonb,now()-interval '9 days')", [`orphan-${randomUUID()}`]);
  return id;
}

for (const backend of testBackends()) test(`${backend}: post-upgrade to a clean plan in at most 3 commands, under the 5-minute ceiling`, async () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  await waveBrain(async ({ engine }) => {
    await withEnv({ CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
      const connector = await rewalkingConnector(engine);
      // A page imported before every import recorded its contextual mode.
      await engine.executeRaw("UPDATE content_chunks SET embedding=$1::text::vector WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug='notes/base')", [VECTOR]);
      await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id='default' AND slug='notes/base'");
      const started = Date.now();
      const commands: string[] = [];

      const banner = (await postUpgradeRecoveryBanner(engine, 'host')).join('\n');
      commands.push('gbrain post-upgrade');
      for (const expected of ['[AGENT] Relay this to your operator', 'connector_checkpoints: 1', 'timeline_history', 'safe_index_pending',
        'connector_rewalk: 1 connector source(s) re-walk their window once', 'gbrain doctor --remediation-plan']) expect(banner).toContain(expected);
      expect(banner).not.toContain('--yes');
      expect(banner).not.toContain('--apply');

      const run = await capture(async () => runRemediate(engine, await approvedRemediateArgs(engine, ['--remediate', '--yes', '--include-repairs', '--no-embed', '--max-usd', '1', '--json'])));
      commands.push('gbrain doctor --remediate --yes --include-repairs --no-embed --max-usd 1');
      const body = JSON.parse(run.out);
      expect(body.repairs.map((r: { kind: string; status: string }) => [r.kind, r.status])).toEqual([
        ['timeline', 'completed'], ['visibility', 'completed'], ['safe-chunks', 'completed'], ['contextual-mode', 'completed'], ['connector-checkpoints', 'completed']]);
      const classes = Object.fromEntries(body.findings.map((f: { check_id: string; class: string }) => [f.check_id, f.class]));
      expect(classes).toMatchObject({ timeline_history: 'cleared', derived_visibility: 'cleared', safe_index_pending: 'cleared', connector_checkpoints: 'cleared',
        persistence_capacity: 'operator_required', parked_effects: 'operator_required', self_capture: 'operator_required', writer_version: 'operator_required',
        stale_embedding_effects: 'operator_required' });
      expect(run.exit).toBe(0);

      const verify = await capture(() => runRemediationPlan(engine, ['--remediation-plan', '--json']));
      commands.push('gbrain doctor --remediation-plan');
      expect(JSON.parse(verify.out).repair_steps).toEqual([]);

      const wallMs = Date.now() - started;
      console.error(`[recovery-run] ${backend} wall_ms=${wallMs} operator_commands=${commands.length}`);
      expect(commands.length).toBeLessThanOrEqual(3);
      expect(wallMs).toBeLessThan(5 * 60_000);
      // The re-walk itself is the connector's next scheduled run, not an operator step.
      expect((await readConnectorSourceStatuses(engine)).get(connector)?.upgrade_recovery).toBe('rewalking_once');
    });
  }, { databaseUrl });
}, 300_000);
