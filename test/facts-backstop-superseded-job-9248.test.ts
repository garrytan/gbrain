import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { preparePageMutation } from '../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { dispatchFactsBackstopEffect } from '../src/core/persistence/effect-facts.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' as const, embedding_disabled: true };
const content = `---\ntype: note\ntitle: Field notes\n---\n\n${'A useful substantive record of this project and its current status. '.repeat(4)}`;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

async function publish(body: string) {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const ctx: OperationContext = { engine, config, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/example');
  const current = await engine.readPageSnapshot('notes/example', { sourceId: 'default', includeDeleted: true });
  const intent: Record<string, unknown> = { content: body };
  if (current) intent.expected_revision = current.revision;
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source.incarnation, slug: 'notes/example', pageId: current?.page.id ?? null, requestId: randomUUID(), callerIntent: intent, intent });
  const row = (await claimNextWrite(engine, localHostId()))!;
  return publishMutation(engine, row, await preparePageMutation(engine, row, config));
}

test('a facts-absorb job that only skipped as superseded does not mark the body extracted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-facts-9248-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await resetPgliteState(engine);
      await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
      await registerLocalWriter(engine, 'cli');
      expect((await publish(content)).outcome?.facts_backstop).toEqual({ queued: true });
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at = now() + interval '1 hour' WHERE kind <> 'facts-backstop'");
      for (;;) {
        const effect = await claimPersistenceEffect(engine, localHostId());
        if (!effect) break;
        await dispatchFactsBackstopEffect(engine, effect, localHostId());
      }
      // The job ran after a revision change and only skipped: no model call, no facts.
      await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', finished_at = now(),
        result = '{"skipped":"superseded"}'::jsonb WHERE name = 'facts-absorb'`);
      const retitled = content.replace('title: Field notes', 'title: Renamed');
      const status = (await publish(retitled)).outcome?.facts_backstop;
      expect(status).toEqual({ queued: true });
    });
  } finally { rmSync(home, { force: true, recursive: true }); }
}, 60_000);
