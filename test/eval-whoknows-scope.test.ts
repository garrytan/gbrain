import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runEvalWhoknows } from '../src/commands/eval-whoknows.ts';
import { withEnv } from './helpers/with-env.ts';

/**
 * Protects: `gbrain eval whoknows` ranks inside the same source scope the
 * `find_experts` op resolves, so pages from a source outside that scope never
 * take a top-3 slot. Fails when the eval calls findExperts with no scope.
 */
describe('eval whoknows source scope', () => {
  let engine: PGLiteEngine;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eval-whoknows-scope-'));
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('archive', 'archive', '{"federated": false}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    const body = (t: string) => `---\ntype: person\ntitle: ${t}\n---\n# ${t}\n\nZyxquartz retrieval specialist.`;
    await importFromContent(engine, 'people/live-zyx', body('Live Zyx'), { sourceId: 'default', noEmbed: true });
    await importFromContent(engine, 'people/archive-zyx', body('Archive Zyx'), { sourceId: 'archive', noEmbed: true });
    writeFileSync(join(dir, 'fixture.jsonl'), JSON.stringify({ query: 'zyxquartz retrieval specialist', expected_top_3_slugs: ['people/live-zyx'] }) + '\n');
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('top-3 never includes a page from a source outside the default scope', async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_SOURCE: undefined }, async () => {
        await runEvalWhoknows(engine, [join(dir, 'fixture.jsonl'), '--skip-replay', '--json']);
      });
    } finally {
      console.log = origLog;
    }
    const report = JSON.parse(lines.join('\n'));
    const top3: string[] = report.quality.rows[0].actual_top_3;
    expect(top3).toContain('people/live-zyx');
    expect(top3).not.toContain('people/archive-zyx');
  });
});
