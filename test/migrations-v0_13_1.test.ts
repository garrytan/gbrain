/**
 * v0.13.1 migration (#7814): the retired `validate: false` grandfather.
 *
 * An upgrade runs v0.13.1 on any brain whose ledger never recorded it (a brain
 * `gbrain init` created before fresh-install stamps, or one opened from a new
 * GBRAIN_HOME). It used to stamp `validate: false` into every page and move
 * every content_hash. It must now record completion and change no page.
 * The whole upgrade runner is covered by test/upgrade-preserves-pages-7814.slow.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { migrations, getMigration } from '../src/commands/migrations/index.ts';
import { v0_13_1 } from '../src/commands/migrations/v0_13_1.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

describe('migrations registry', () => {
  test('v0.13.1 is registered in semver order after v0.12.0', () => {
    expect(getMigration('0.13.1')?.version).toBe('0.13.1');
    const versions = migrations.map(m => m.version);
    expect(versions.indexOf('0.13.1')).toBeGreaterThan(versions.indexOf('0.12.0'));
  });

  test('v0.13.1 feature pitch has headline + description', () => {
    expect(v0_13_1.featurePitch.headline.length).toBeGreaterThan(10);
    expect(v0_13_1.featurePitch.description?.length).toBeGreaterThan(20);
  });
});

describe('v0_13_1 orchestrator writes no page (#7814)', () => {
  test('a brain with pages and no ledger keeps every page, content_hash and frontmatter unchanged', async () => {
    const home = mkdtempSync(join(tmpdir(), 'v0_13_1-'));
    try {
      const databasePath = join(home, '.gbrain', 'brain.pglite');
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath, embedding_disabled: true }) + '\n');
      const state = async () => {
        const engine = new PGLiteEngine();
        await engine.connect({ database_path: databasePath });
        try {
          return await engine.executeRaw('SELECT source_id, slug, content_hash, frontmatter::text AS frontmatter, knowledge_revision::text AS revision FROM pages ORDER BY slug');
        } finally { await engine.disconnect(); }
      };
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const engine = new PGLiteEngine();
        await engine.connect({ database_path: databasePath });
        try {
          await engine.initSchema();
          await engine.putPage('concepts/alpha-example', { type: 'concept', title: 'Alpha', compiled_truth: 'Alpha body.', frontmatter: { source_kind: 'note' } });
          await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice body.' });
        } finally { await engine.disconnect(); }
        const before = await state();

        for (const dryRun of [false, true]) {
          const result = await v0_13_1.orchestrator({ yes: true, dryRun, noAutopilotInstall: true });
          expect(result.status).toBe('complete');
          expect(result.files_rewritten ?? 0).toBe(0);
          expect(result.phases.map(p => [p.name, p.status])).toEqual([['grandfather', 'skipped']]);
        }

        const after = await state();
        expect(after).toEqual(before);
        expect(after.map(row => String(row.frontmatter))).not.toContainEqual(expect.stringContaining('validate'));
        expect(existsSync(join(home, '.gbrain', 'migrations', 'v0_13_1-rollback.jsonl'))).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
