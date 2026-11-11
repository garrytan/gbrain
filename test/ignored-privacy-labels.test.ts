/**
 * GST-2462: ignoredPrivacyLabels (TypeScript, used by put_page) and ignoredPrivacyLabelSql (SQL, used by import, sync
 * and doctor) are one rule. Every page of the matrix gets the same answer from both, on each engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { ignoredPrivacyLabels, ignoredPrivacyLabelSql, privacyLabelKeySql } from '../src/core/search/ignored-privacy-labels.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const MATRIX: Array<{ type: string; frontmatter: Record<string, unknown> }> = [
  { type: 'note', frontmatter: { access: 'personal' } },
  { type: 'note', frontmatter: { access: '  PERSONAL  ' } },
  { type: 'note', frontmatter: { access: 'Private' } },
  { type: 'note', frontmatter: { access: ' restricted ' } },
  { type: 'note', frontmatter: { confidentiality: 'health record (invented)' } },
  { type: 'note', frontmatter: { confidentiality: 'SECRET' } },
  { type: 'note', frontmatter: { access: 'personal', confidentiality: 'secret' } },
  { type: 'note', frontmatter: { access: 'personal', confidentiality: 'internal-example' } },
  { type: 'note', frontmatter: { access: '' } },
  { type: 'note', frontmatter: { access: '   ' } },
  { type: 'note', frontmatter: { access: null } },
  { type: 'note', frontmatter: { access: ['private'] } },
  { type: 'note', frontmatter: { access: true } },
  { type: 'note', frontmatter: { access: 7 } },
  { type: 'note', frontmatter: { access: 'personal', visibility: 'world' } },
  { type: 'note', frontmatter: { access: 'personal', visibility: 'private' } },
  { type: 'note', frontmatter: { access: 'personal', visibility: null } },
  { type: 'note', frontmatter: { access: 'personal', pinned_question: true } },
  { type: 'note', frontmatter: { access: 'personal', derived_from: 'notes/origin-example' } },
  { type: 'note', frontmatter: { access: 'personal', source_slug: 'notes/origin-example' } },
  { type: 'atom', frontmatter: { access: 'personal' } },
  { type: 'question', frontmatter: { access: 'personal' } },
  { type: 'concept', frontmatter: { access: 'personal', synthesized_by: 'dream' } },
  { type: 'concept', frontmatter: { access: 'personal' } },
  { type: 'event', frontmatter: { access: 'personal', captured_via: 'life-chronicle:meeting' } },
  { type: 'event', frontmatter: { access: 'personal', captured_via: 'calendar' } },
  { type: 'note', frontmatter: { status: 'draft' } },
];

for (const kind of testBackends()) {
  describe(`ignored privacy labels: TypeScript and SQL agree (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('every page of the matrix', async () => {
      const rows = await engine.executeRaw<{ i: number; hit: boolean }>(
        `SELECT (m.ordinality - 1)::int AS i, (${privacyLabelKeySql('p')} AND ${ignoredPrivacyLabelSql('p')}) AS hit
          FROM jsonb_array_elements($1::text::jsonb) WITH ORDINALITY AS m(v, ordinality)
          CROSS JOIN LATERAL (SELECT m.v->>'type' AS type, m.v->'frontmatter' AS frontmatter) p ORDER BY 1`, [JSON.stringify(MATRIX)]);
      const ts = MATRIX.map(page => ignoredPrivacyLabels(page).length > 0);
      expect(rows.map(r => r.hit === true)).toEqual(ts);
      expect(ts.filter(Boolean).length).toBe(10);
    });

    test('values are named as written, trimmed; non-string values by their JSON text', () => {
      expect(ignoredPrivacyLabels({ type: 'note', frontmatter: { access: '  PERSONAL  ' } })).toEqual([{ key: 'access', value: 'PERSONAL' }]);
      expect(ignoredPrivacyLabels({ type: 'note', frontmatter: { access: ['private'] } })).toEqual([{ key: 'access', value: '["private"]' }]);
      expect(ignoredPrivacyLabels({ type: 'note', frontmatter: { access: 'personal', confidentiality: 'internal-example' } }))
        .toEqual([{ key: 'access', value: 'personal' }, { key: 'confidentiality', value: 'internal-example' }]);
    });
  });
}
