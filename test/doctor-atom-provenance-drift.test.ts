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
import type { BrainEngine } from '../src/core/engine.ts';

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

  it('tolerates a malformed extracted_at (one bad row must not abort the whole check)', async () => {
    // Review fix: the unguarded ::timestamptz cast made ONE hand-edited /
    // truncated extracted_at value abort the entire aggregate, permanently
    // degrading the check to a spurious "check failed" warn.
    await seedSource('src-m', 'original body');
    await engine.putPage('atoms/2026-01-01/m-000000', {
      type: 'atom',
      title: 'm',
      compiled_truth: 'claim body',
      frontmatter: {
        type: 'atom',
        source_slug: 'src-m',
        source_hash: await hashOf('src-m'),
        extracted_at: 'not-a-timestamp',
      },
    });
    const c = await computeAtomProvenanceDriftCheck(engine);
    expect(c.message).not.toContain('check failed');
    expect(c.status).toBe('ok');
    expect((c.details as Record<string, number>).total_atoms).toBe(1);
    expect((c.details as Record<string, number>).drifted).toBe(0);
  });

  it('still reports oldest_drifted_days from the well-formed rows when a malformed one exists', async () => {
    await seedSource('src-n', 'original body');
    // Drifted atom with a good timestamp ~10 days ago.
    await engine.putPage('atoms/2026-01-01/n-000000', {
      type: 'atom', title: 'n0', compiled_truth: 'claim body',
      frontmatter: {
        type: 'atom', source_slug: 'src-n', source_hash: 'deadbeefdeadbeef',
        extracted_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      },
    });
    // Drifted atom with a garbage timestamp — must not abort or win "oldest".
    await engine.putPage('atoms/2026-01-01/n-000001', {
      type: 'atom', title: 'n1', compiled_truth: 'claim body',
      frontmatter: {
        type: 'atom', source_slug: 'src-n', source_hash: 'deadbeefdeadbeef',
        extracted_at: 'unknown',
      },
    });
    const c = await computeAtomProvenanceDriftCheck(engine);
    expect(c.message).not.toContain('check failed');
    const d = c.details as Record<string, number>;
    expect(d.drifted).toBe(2);
    expect(d.oldest_drifted_days).toBeGreaterThanOrEqual(9.5);
    expect(d.oldest_drifted_days).toBeLessThanOrEqual(10.5);
  });

  it('stays ok when the count floor is met but the ratio is under 10% (26 drifted of 300)', async () => {
    // Both thresholds must trip: 26 >= MIN_DRIFTED (25) but 26/300 = 8.7% is
    // under WARN_RATIO (0.1) — a large, mostly-healthy brain mid-cycle.
    await seedSource('src-r', 'original body');
    const live = await hashOf('src-r');
    for (let i = 0; i < 274; i++) {
      await seedAtom(`atoms/2026-01-01/r-${String(i).padStart(6, '0')}`, 'src-r', live);
    }
    for (let i = 0; i < 26; i++) {
      await seedAtom(`atoms/2026-01-01/rd-${String(i).padStart(6, '0')}`, 'src-r', 'deadbeefdeadbeef');
    }
    const c = await computeAtomProvenanceDriftCheck(engine);
    const d = c.details as Record<string, number>;
    expect(d.total_atoms).toBe(300);
    expect(d.drifted).toBe(26);
    expect(d.drift_pct).toBeCloseTo(8.7, 1);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('below warn threshold');
  }, 120_000);

  it('a throwing executeRaw degrades to a warn that names the check — never throws, never fails doctor', async () => {
    const broken = {
      executeRaw: async () => { throw new Error('relation "pages" does not exist'); },
    } as unknown as BrainEngine;
    const c = await computeAtomProvenanceDriftCheck(broken);
    expect(c.name).toBe('atom_provenance_drift');
    expect(c.status).toBe('warn');
    expect(c.message).toContain('atom_provenance_drift check failed');
    expect(c.message).toContain('relation "pages" does not exist');
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
