/**
 * atom_provenance_drift doctor check.
 *
 * Pins:
 *  - an atom whose `source_hash` matches a live page's content_hash prefix is
 *    NOT drift (the healthy steady state);
 *  - editing the source page moves its content_hash and strands the atom, and
 *    the check splits that from the case where the source page is gone;
 *  - `pending:` in-flight markers are excluded (they are written before the
 *    extraction commits and would otherwise all read as drift);
 *  - warn needs BOTH the ratio and the absolute count, so a brain with a
 *    handful of atoms doesn't flap.
 *
 * Real in-memory PGLite (canonical block, R3+R4).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { computeAtomProvenanceDriftCheck } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Returns the first 16 chars of the stored content_hash — what atoms record. */
async function hashOf(slug: string): Promise<string> {
  const rows = await engine.executeRaw<{ h: string }>(
    `SELECT substring(content_hash from 1 for 16) AS h FROM pages WHERE slug = $1`,
    [slug],
  );
  return rows[0].h;
}

async function seedSource(slug: string, body: string) {
  await engine.putPage(slug, { type: 'article', title: slug, compiled_truth: body });
}

async function seedAtom(slug: string, sourceSlug: string, sourceHash: string) {
  await engine.putPage(slug, {
    type: 'atom',
    title: slug,
    compiled_truth: 'claim body',
    frontmatter: {
      type: 'atom',
      source_slug: sourceSlug,
      source_hash: sourceHash,
      extracted_at: new Date().toISOString(),
    },
  });
}

describe('computeAtomProvenanceDriftCheck', () => {
  it('is ok on a brain with no atoms', async () => {
    const c = await computeAtomProvenanceDriftCheck(engine);
    expect(c.name).toBe('atom_provenance_drift');
    expect(c.status).toBe('ok');
    expect((c.details as Record<string, number>).total_atoms).toBe(0);
  });

  it('does not flag an atom whose source_hash still resolves', async () => {
    await seedSource('src-a', 'original body');
    await seedAtom('atoms/2026-01-01/a-000000', 'src-a', await hashOf('src-a'));
    const c = await computeAtomProvenanceDriftCheck(engine);
    expect(c.status).toBe('ok');
    expect((c.details as Record<string, number>).drifted).toBe(0);
  });

  it('counts an edited source as source_changed, not source_gone', async () => {
    await seedSource('src-b', 'original body');
    await seedAtom('atoms/2026-01-01/b-000000', 'src-b', await hashOf('src-b'));
    // Same slug, new content → content_hash moves, atom is stranded.
    await seedSource('src-b', 'rewritten body');
    const d = (await computeAtomProvenanceDriftCheck(engine)).details as Record<string, number>;
    expect(d.drifted).toBe(1);
    expect(d.source_changed).toBe(1);
    expect(d.source_gone).toBe(0);
  });

  it('counts a removed source page as source_gone', async () => {
    await seedSource('src-c', 'original body');
    await seedAtom('atoms/2026-01-01/c-000000', 'src-c', await hashOf('src-c'));
    await engine.executeRaw(`DELETE FROM pages WHERE slug = $1`, ['src-c']);
    const d = (await computeAtomProvenanceDriftCheck(engine)).details as Record<string, number>;
    expect(d.drifted).toBe(1);
    expect(d.source_changed).toBe(0);
    expect(d.source_gone).toBe(1);
  });

  it('excludes in-flight pending: markers', async () => {
    await seedSource('src-d', 'original body');
    await seedAtom('atoms/2026-01-01/d-000000', 'src-d', `pending:${await hashOf('src-d')}`);
    const d = (await computeAtomProvenanceDriftCheck(engine)).details as Record<string, number>;
    expect(d.total_atoms).toBe(0);
    expect(d.drifted).toBe(0);
  });

  it('stays ok below the absolute-count floor even at 100% drift', async () => {
    await seedSource('src-e', 'original body');
    await seedAtom('atoms/2026-01-01/e-000000', 'src-e', 'deadbeefdeadbeef');
    const c = await computeAtomProvenanceDriftCheck(engine);
    expect((c.details as Record<string, number>).drift_pct).toBe(100);
    expect(c.status).toBe('ok'); // 1 drifted < MIN_DRIFTED
  });

  it('warns once both the ratio and the count are exceeded', async () => {
    // 30 drifted out of 30 → over MIN_DRIFTED (25) and over WARN_RATIO (0.1).
    await seedSource('src-f', 'original body');
    for (let i = 0; i < 30; i++) {
      await seedAtom(`atoms/2026-01-01/f-${String(i).padStart(6, '0')}`, 'src-f', 'deadbeefdeadbeef');
    }
    const c = await computeAtomProvenanceDriftCheck(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('30/30');
    expect(c.message).toContain('source page is gone');
  });
});
