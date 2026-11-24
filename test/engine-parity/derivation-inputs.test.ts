/**
 * Engine parity for the derivation edges (`derivation_inputs`, src/core/facts/derivation-inputs.ts): the deriver's write
 * (`recordDerivationEdges`) and every read of the edges, on every engine (loss row 34 of docs/designs/RUST_ENGINE.md).
 *
 * Fail-first: on rust-engine/cli-members-next 3c72fae727 the Rust arm stopped on the typed refusal of
 * `recordDerivationEdges` in every case (the store kept no `derivation_inputs`); its tally pin, all equal, failed.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) recorded edges are walked: `derivedRowsFrom` (the `listDerivedRows` hop) reaches each derived row
 *    transitively, with its depth, and a second record of the same edge adds nothing. (2) An edge under a source that
 *    does not exist refuses with the source foreign key and records nothing. (3) `listFactsFromQuotedPages` counts a fact
 *    whose recorded input page has a quoted type. (4) `countLegacyDerivedPages` counts the live atom and dream pages no
 *    edge explains. (5) In an engine scope at the current schema, a non-owner read hides a page and a fact derived (by
 *    their recorded inputs, transitively) from a fact in an owner-only source.
 *  - Regression: the Rust store kept no edges, so every deriver that records them (extract-takes' taint edges, atoms,
 *    consolidation) stopped there on a Rust brain, and once edges exist a read that ignored them would show an
 *    owner-only row's derivatives to a non-owner.
 *  - Why existing coverage misses it: test/facts-purge*.test.ts and the owner-only tests write the edges with SQL on
 *    PGLite and Postgres only.
 *  - Seam: none. Real engines, typed members only; the owner-only source is a harness fixture.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { derivedRowsFrom, recordDerivationInputs } from '../../src/core/facts/derivation-inputs.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());
const OWN = 'own-texts';
const at = (iso: string) => new Date(iso);

async function page(engine: BrainEngine, slug: string, type: string, sourceId = 'default', frontmatter: Record<string, unknown> = {}) {
  return engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter }, { sourceId });
}

async function fact(engine: BrainEngine, text: string, sourceId = 'default') {
  return engine.insertFact({ fact: text, entity_slug: null, source: 'mcp:remember', valid_from: at('2026-01-02T00:00:00Z') }, { source_id: sourceId });
}

describe('engine parity: derivation edges', () => {
  parityTest('recorded edges are walked transitively, and a repeated edge adds nothing', {
    methods: ['putPage', 'insertFact', 'recordDerivationEdges', 'listDerivedRows'],
  }, async (engine) => {
    const input = await fact(engine, 'An input claim');
    const atom = await page(engine, 'atoms/one', 'atom');
    const summary = await page(engine, 'dream/summary', 'note');
    await recordDerivationInputs(engine, { table: 'pages', id: atom.id, sourceId: 'default' }, [{ table: 'facts', id: input.id }]);
    await recordDerivationInputs(engine, { table: 'pages', id: summary.id, sourceId: 'default' }, [{ table: 'pages', id: atom.id }]);
    await recordDerivationInputs(engine, { table: 'pages', id: atom.id, sourceId: 'default' }, [{ table: 'facts', id: input.id }]);
    const walk = await derivedRowsFrom(engine, [{ table: 'facts', id: input.id }]);
    const name = (r: { table: string; id: string }) => (r.id === String(atom.id) ? 'atoms/one' : r.id === String(summary.id) ? 'dream/summary' : r.id);
    const out = { rows: walk.rows.map(r => ({ table: r.table, row: name(r), depth: r.depth })), truncated: walk.truncated };
    expect(out).toEqual({ rows: [{ table: 'pages', row: 'atoms/one', depth: 1 }, { table: 'pages', row: 'dream/summary', depth: 2 }], truncated: false });
    return out;
  });

  parityTest('an edge under a source that does not exist refuses with the source foreign key and records nothing', {
    methods: ['putPage', 'recordDerivationEdges', 'listDerivedRows'],
  }, async (engine) => {
    const atom = await page(engine, 'atoms/orphan', 'atom');
    const refused = await recordDerivationInputs(engine, { table: 'pages', id: atom.id, sourceId: 'no-such-source' }, [{ table: 'facts', id: 1 }])
      .then(() => 'recorded', (e: Error) => /derivation_inputs_source_id_fkey/.test(e.message) ? 'fkey' : e.message);
    const walk = await derivedRowsFrom(engine, [{ table: 'facts', id: 1 }]);
    const out = { refused, rows: walk.rows.length };
    expect(out).toEqual({ refused: 'fkey', rows: 0 });
    return out;
  });

  parityTest('the quote read counts a fact whose recorded input page has a quoted type', {
    methods: ['putPage', 'insertFact', 'recordDerivationEdges', 'listFactsFromQuotedPages'],
  }, async (engine) => {
    const transcript = await page(engine, 'chats/today', 'transcript');
    const note = await page(engine, 'notes/plain', 'note');
    const quoted = await fact(engine, 'Said in the chat');
    const plain = await fact(engine, 'Written in a note');
    const bare = await fact(engine, 'No input recorded');
    await recordDerivationInputs(engine, { table: 'facts', id: quoted.id, sourceId: 'default' }, [{ table: 'pages', id: transcript.id }]);
    await recordDerivationInputs(engine, { table: 'facts', id: plain.id, sourceId: 'default' }, [{ table: 'pages', id: note.id }]);
    const ids = await engine.listFactsFromQuotedPages({ ids: [quoted.id, plain.id, bare.id], pageTypes: ['transcript'],
      backstop: [['sync', 'sync:'], ['put', 'put:']] });
    const out = { quoted: ids.map(id => (id === quoted.id ? 'quoted' : id === plain.id ? 'plain' : 'bare')) };
    expect(out).toEqual({ quoted: ['quoted'] });
    return out;
  });

  parityTest('the legacy count leaves out the atom and dream pages an edge explains', {
    methods: ['putPage', 'insertFact', 'recordDerivationEdges', 'countLegacyDerivedPages'],
  }, async (engine) => {
    const input = await fact(engine, 'A claim');
    const explained = await page(engine, 'atoms/explained', 'atom');
    await page(engine, 'atoms/legacy', 'atom');
    await page(engine, 'dream/legacy', 'note', 'default', { dream_generated: true });
    await page(engine, 'notes/ordinary', 'note');
    const before = await engine.countLegacyDerivedPages('default');
    await recordDerivationInputs(engine, { table: 'pages', id: explained.id, sourceId: 'default' }, [{ table: 'facts', id: input.id }]);
    const after = await engine.countLegacyDerivedPages('default');
    const out = { before, after };
    expect(out).toEqual({ before: 3, after: 2 });
    return out;
  });

  parityTest('a non-owner read hides a page and a fact derived, transitively, from an owner-only fact', {
    methods: ['putPage', 'insertFact', 'recordDerivationEdges', 'listPages', 'listFactsSince'],
  }, async (engine, backend) => {
    await createSource(engine, backend, OWN, { owner_only: true });
    const secret = await fact(engine, 'From the texts', OWN);
    const atom = await page(engine, 'atoms/from-texts', 'atom');
    const summary = await page(engine, 'notes/summary-of-atom', 'note');
    await page(engine, 'notes/open', 'note');
    const derived = await fact(engine, 'Derived from the atom');
    await fact(engine, 'Open claim');
    await recordDerivationInputs(engine, { table: 'pages', id: atom.id, sourceId: 'default' }, [{ table: 'facts', id: secret.id }]);
    await recordDerivationInputs(engine, { table: 'pages', id: summary.id, sourceId: 'default' }, [{ table: 'pages', id: atom.id }]);
    await recordDerivationInputs(engine, { table: 'facts', id: derived.id, sourceId: 'default' }, [{ table: 'pages', id: atom.id }]);
    noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
    const out = await withEngineScope(engine, async () => ({
      pages: (await engine.listPages({ sort: 'slug', sourceIds: ['default'], excludePrivate: true })).map(p => p.slug),
      facts: sorted((await engine.listFactsSince('default', at('2020-01-01T00:00:00Z'), { limit: 50, excludePrivate: true })).map(f => f.fact)),
      open: (await engine.listPages({ sort: 'slug', sourceIds: ['default'] })).map(p => p.slug),
    }));
    expect(out).toEqual({ pages: ['notes/open'], facts: ['Open claim'],
      open: ['atoms/from-texts', 'notes/open', 'notes/summary-of-atom'] });
    return out;
  });
});
