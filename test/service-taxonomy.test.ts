import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_DOMAINS, SERVICE_TAXONOMY } from '../src/core/services/service-taxonomy.ts';

const SERVICES_DIR = join(import.meta.dir, '..', 'src', 'core', 'services');

function serviceFilesOnDisk(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => statSync(join(SERVICES_DIR, name)).isFile())
    .sort();
}

function assignedFiles(): string[] {
  return Object.values(SERVICE_TAXONOMY).flatMap((files) => [...files]);
}

describe('service taxonomy (O8 ratchet)', () => {
  test('every service file on disk is assigned to exactly one domain', () => {
    const onDisk = serviceFilesOnDisk();
    const assigned = assignedFiles();
    const assignedSet = new Set(assigned);

    // A NEW service file must be consciously assigned to a domain in
    // src/core/services/service-taxonomy.ts — it can never land unclassified.
    const unassigned = onDisk.filter((name) => !assignedSet.has(name));
    expect(unassigned).toEqual([]);

    // No file may belong to two domains.
    const seen = new Set<string>();
    const doubleAssigned = assigned.filter((name) => {
      if (seen.has(name)) return true;
      seen.add(name);
      return false;
    });
    expect(doubleAssigned).toEqual([]);
  });

  test('the taxonomy never goes stale (assignments only shrink with deletions)', () => {
    const onDisk = new Set(serviceFilesOnDisk());
    // An entry may only be removed when its file is deleted or renamed;
    // entries pointing at missing files fail here.
    const stale = assignedFiles().filter((name) => !onDisk.has(name));
    expect(stale).toEqual([]);
  });

  test('domain assignments are sorted and every domain has a boundary note', () => {
    for (const [domain, files] of Object.entries(SERVICE_TAXONOMY)) {
      const sorted = [...files].sort();
      expect([...files]).toEqual(sorted);
      expect(files.length).toBeGreaterThan(0);
      const note = SERVICE_DOMAINS[domain as keyof typeof SERVICE_DOMAINS];
      expect(typeof note).toBe('string');
      expect(note.length).toBeGreaterThan(0);
    }
  });
});
