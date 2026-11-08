/**
 * #8848: derived_visibility counts an unstamped concept with no recoverable lineage,
 * so `gbrain repair visibility` must stamp it (private, as remote reads already treat it).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-novis-lineage-'));
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

const ctx = () => ({ engine, config: { engine: engine.kind, embedding_disabled: true },
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' }) as never;

test('repair visibility stamps an unstamped concept without lineage and clears the warn', async () => {
  const r = await importFromContent(engine, 'concepts/lonely',
    serializeMarkdown({ synthesized_by: 'synthesize_concepts-v0.41' }, 'lonely concept body', '', { type: 'concept' as never, title: 'lonely', tags: [] }),
    { noEmbed: true, forceRechunk: true });
  expect(['imported', 'skipped']).toContain(r.status);
  expect((await derivedVisibilityCheck(engine)).status).toBe('warn');
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const scope = await resolveRepairScope(engine);
    await runRepair(ctx(), visibilityRepair, scope, { apply: true });
  });
  const v = (await engine.executeRaw<{ v: string | null }>("SELECT frontmatter->>'visibility' AS v FROM pages WHERE slug='concepts/lonely'"))[0]?.v ?? null;
  expect(v).toBe('private');
  expect((await derivedVisibilityCheck(engine)).status).toBe('ok');
});
