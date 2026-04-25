/**
 * Scenario S9 — Broad synthesis prefers curated over map edges.
 *
 * Falsifies L2: "Prefer curated Markdown over inferred map edges when the
 * two disagree in emphasis or confidence."
 *
 * The scenario requires broad synthesis to separate canonical reads from
 * derived map suggestions, then prefer canonical curated notes as the first
 * route entrypoint when both sources mention the same entity.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildStructuralContextMapEntry, workspaceContextMapId } from '../../src/core/services/context-map-service.ts';
import { getBroadSynthesisRoute } from '../../src/core/services/broad-synthesis-route-service.ts';

describe('S9 — canonical-first synthesis', () => {
  test('broad synthesis returns curated note before map-derived edge when both exist for the same entity', async () => {
    await withScenarioBrain(async (engine) => {
      const mapId = await seedCanonicalAndDerivedMapFixture(engine);

      const result = await getBroadSynthesisRoute(engine, {
        query: 'Canonical Memory',
      });

      expect(result.selection_reason).toBe('selected_fresh_match');
      expect(result.route?.entrypoints[0]?.source_kind).toBe('curated_note');
      expect(result.route?.entrypoints[0]?.page_slug).toBe('concepts/canonical-memory');
      expect(result.route?.canonical_reads[0]?.page_slug).toBe('concepts/canonical-memory');
      expect(result.route?.derived_suggestions[0]?.map_id).toBe(mapId);
      expect(result.route?.conflicts[0]?.resolution).toBe('prefer_canonical');
    });
  });

  test('map-derived source overlap is not treated as co-equal canonical truth', async () => {
    await withScenarioBrain(async (engine) => {
      await seedCanonicalAndDerivedMapFixture(engine);

      const result = await getBroadSynthesisRoute(engine, {
        query: 'Canonical Memory',
      });

      expect(result.route?.canonical_reads.map((read) => read.page_slug)).toContain('concepts/canonical-memory');
      expect(result.route?.derived_suggestions.length).toBeGreaterThan(0);
      expect(result.route?.entrypoints[0]?.source_kind).toBe('curated_note');
      expect(result.route?.conflicts).toHaveLength(1);
      expect(result.route?.conflicts[0]?.canonical_page_slug).toBe('concepts/canonical-memory');
      expect(result.route?.conflicts.every((conflict) => conflict.resolution === 'prefer_canonical')).toBe(true);
    });
  });
});

async function withScenarioBrain(run: (engine: SQLiteEngine) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-s09-canonical-first-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function seedCanonicalAndDerivedMapFixture(engine: SQLiteEngine): Promise<string> {
  await importFromContent(engine, 'concepts/canonical-memory', [
    '---',
    'type: concept',
    'title: Canonical Memory',
    '---',
    '# Compiled truth',
    'Canonical Memory is the curated source of truth for broad synthesis.',
    'It should outrank map-derived orientation when both mention Canonical Memory.',
    '[Source: User, direct message, 2026-04-25 09:05 AM KST]',
  ].join('\n'), { path: 'concepts/canonical-memory.md' });

  await importFromContent(engine, 'systems/derived-memory-map', [
    '---',
    'type: system',
    'title: Derived Memory Map',
    '---',
    '# Overview',
    'A structural orientation page links to [[concepts/canonical-memory]] and may emphasize derived map context.',
    '[Source: User, direct message, 2026-04-25 09:06 AM KST]',
  ].join('\n'), { path: 'systems/derived-memory-map.md' });

  await buildStructuralContextMapEntry(engine);
  return workspaceContextMapId('workspace:default');
}
