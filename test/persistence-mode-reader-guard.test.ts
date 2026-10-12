/**
 * #6482 (fix wave 15 P4.1) guard: `persistence_brain.enabled` is read through
 * `readManagedMode` / `readPersistenceBrain` (`src/core/persistence/managed-mode.ts`,
 * re-exported by `ownership.ts`) and nowhere else. A raw `SELECT … enabled … FROM
 * persistence_brain` in product code is a mode reader that can fail open again
 * (an empty or malformed read routed a managed brain through the unmanaged
 * writer); route it through the shared predicate, with `{ lock }` when the
 * caller serialized on the row. Non-test `src/` only; generated blobs and DDL
 * (trigger bodies, migrations) are schema, not readers, and are listed below.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC = join(ROOT, 'src');

/** Files allowed to carry the raw statement, each with the reason it is not a mode reader. */
const ALLOWED: Record<string, string> = {
  'src/core/persistence/managed-mode.ts': 'the one reader',
  'src/core/persistence/writer-guard-schema.ts': 'DDL: the managed-writer trigger body runs in the database',
  'src/core/shared-skills/persistence-schema.ts': 'DDL: shared-skill trigger bodies',
  'src/core/persistence/graduation-target.ts': 'target seed census (bool_and(NOT enabled) over an expected-empty target), not a mode read',
  'src/core/persistence/admin-intent.ts': 'the writer-admin state digest hashes the whole row inside jsonb_build_object; it routes nothing',
};
const GENERATED = /\.generated\.ts$|^src\/core\/schema-migrations\//;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith('.ts')) yield path;
  }
}

/** Every `SELECT … FROM persistence_brain …` statement that names `enabled` (not `skill_bundles_enabled`) in its columns or its WHERE clause. */
function rawModeReads(source: string): string[] {
  const flat = source.replace(/\s+/g, ' ');
  const hits: string[] = [];
  const re = /SELECT\b((?:(?!\bFROM\b|\bSELECT\b).)*?)\bFROM\s+persistence_brain\b([^;'"`]{0,80})/gi;
  for (const match of flat.matchAll(re)) if (/(?<!\w)(?:\w+\.)?enabled\b/i.test(match[1] + match[2])) hits.push(match[0]);
  return hits;
}

describe('persistence mode readers (#6482)', () => {
  test('no product file outside managed-mode.ts selects persistence_brain.enabled', () => {
    const offenders: string[] = [];
    for (const path of walk(SRC)) {
      const rel = relative(ROOT, path).split('\\').join('/');
      if (GENERATED.test(rel) || rel in ALLOWED) continue;
      const hits = rawModeReads(readFileSync(path, 'utf8'));
      if (hits.length) offenders.push(`${rel}: ${hits[0].slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the allow-list only names files that still need it', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(rawModeReads(readFileSync(join(ROOT, rel), 'utf8')).length, `${rel} no longer carries a raw read; drop it from ALLOWED`).toBeGreaterThan(0);
    }
  });

  test('the matcher sees every reader shape this guard replaced', () => {
    expect(rawModeReads("engine.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1')")).toHaveLength(1);
    expect(rawModeReads("tx.executeRaw('SELECT enabled FROM persistence_brain WHERE singleton=1 FOR SHARE')")).toHaveLength(1);
    expect(rawModeReads("`SELECT brain_id, enabled, mode_epoch,\n (to_jsonb(persistence_brain)->>'x')::int AS y\n FROM persistence_brain WHERE singleton=1${lock}`")).toHaveLength(1);
    expect(rawModeReads("\"SELECT brain_id,enabled,to_jsonb(persistence_brain)->>'mode_epoch' AS mode_epoch FROM persistence_brain WHERE singleton=1\"")).toHaveLength(1);
    expect(rawModeReads("`WHERE NOT COALESCE((SELECT enabled FROM persistence_brain WHERE singleton=1), false)`")).toHaveLength(1);
    expect(rawModeReads("'SELECT skill_bundles_enabled FROM persistence_brain WHERE singleton=1'")).toHaveLength(0);
    expect(rawModeReads("'SELECT brain_id FROM persistence_brain WHERE singleton=1'")).toHaveLength(0);
    expect(rawModeReads("'SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE'")).toHaveLength(0);
  });
});
