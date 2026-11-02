/**
 * Value: protects=brainstorm --save reports a save refused for a non-private import hold as not saved (exit 1, nothing stored); fails_when=persistSavedIdea ignores imported.refusal and returns dbSaved true;
 * why_new=brainstorm-private-hold-7897.test.ts covers only the visibility_noncanonical refusal; seam=none; no_claim=Postgres arm and the Git write-through path (PGLite, repo-less source only).
 *
 * #7897: persistSavedIdea (src/commands/brainstorm.ts) used to ignore importFromContent's result. A refusal other than
 * the private-request hold (here unparseable frontmatter YAML) must also surface as a failed save.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatSaveOutcome, persistSavedIdea } from '../src/commands/brainstorm.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-brainstorm-refusal-7897-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

describe('brainstorm --save, unmanaged, repo-less: a refusal other than the private hold (#7897)', () => {
  for (const [name, content] of [
    ['unparseable frontmatter YAML', '---\ntype: note\ntitle: [Example\nkey: : :\n---\n# Example\n\nIdeas about acme-example.\n'],
  ] as const) test(`${name} is reported not saved and stores nothing`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const sourceId = `source-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,NULL)', [sourceId]);
    const slug = `wiki/ideas/example-${randomUUID().slice(0, 8)}`;
    const outcome = await persistSavedIdea(engine, { slug, content, sourceId, provenanceVia: 'brainstorm' });
    expect({ dbSaved: outcome.dbSaved, hasError: !!outcome.dbError, exit: formatSaveOutcome(outcome, { profileLabel: 'brainstorm', slug }).exitCode }).toEqual({ dbSaved: false, hasError: true, exit: 1 });
    expect(await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true })).toBeNull();
  }), 60_000);
});
