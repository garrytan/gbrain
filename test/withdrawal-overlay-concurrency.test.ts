import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { recordFactWithdrawal, preserveWithdrawnFenceRows } from '../src/core/facts/withdrawal.ts';
import { hasAmbiguousWithdrawalFence, withdrawalFenceBlocks } from '../src/core/facts/withdrawal-overlay.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';
import { withEnv } from './helpers/with-env.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { PreparedContentImport } from '../src/core/persistence/prepared-import.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let disposePostgres: (() => Promise<void>) | undefined;
const sourceId = 'withdrawal-overlay-test';
beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(fixture.engine); disposePostgres = fixture.close;
  }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await disposePostgres?.();
}, 60_000);

function fact(claim: string, extra: Partial<ParsedFact> = {}): ParsedFact {
  return { rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium',
    active: true, context: 'Original evidence context', ...extra };
}

test('an unterminated facts fence remains conservatively ambiguous', () => {
  expect(hasAmbiguousWithdrawalFence(`${FACTS_FENCE_BEGIN}\n| 1 | fact | world |`)).toBe(true);
});

test('inline marker documentation is not a fence, while a trailing standalone fence remains ambiguous', () => {
  expect(hasAmbiguousWithdrawalFence(`Use \`${FACTS_FENCE_BEGIN}\` to start a fact table.`)).toBe(false);
  expect(hasAmbiguousWithdrawalFence(`${renderFactsTable([fact('complete fence')])}\n${FACTS_FENCE_BEGIN}\n| 2 | trailing claim |`)).toBe(true);
  expect(withdrawalFenceBlocks(`Use \`${FACTS_FENCE_BEGIN}\` here.\n${renderFactsTable([fact('real fence')])}`)).toHaveLength(1);
});

test('withdrawal covers prior context, inactive history and every legacy fence by fingerprint', async () => {
  const active = 'withdrawalcontextsentinel active claim';
  const expired = 'withdrawalhistorysentinel expired claim';
  const body = `Safe prose\n${renderFactsTable([fact(active), fact(active, { rowNum: 2, visibility: 'private' })])}
Historical section\n${renderFactsTable([fact(expired, { active: false, validUntil: '2020-01-01', context: 'superseded by #9' })])}`;
  for (const engine of engines) {
    await engine.putPage('legacy-withdrawal', { type: 'note', title: 'Synthetic legacy facts', compiled_truth: body }, { sourceId });
    for (const claim of [active, expired]) {
      const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: sourceId });
      expect((await recordFactWithdrawal(engine, stored.id, sourceId, true)).withdrawn).toBe(true);
    }
    const snapshot = (await engine.readPageSnapshot('legacy-withdrawal', { sourceId }))!;
    const rows = withdrawalFenceBlocks(snapshot.page.compiled_truth).flatMap(block => block.parsed.facts);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ active: false, forgotten: true });
    expect(rows[0].context).toStartWith('forgotten:');
    expect(rows[0].context).toContain('Original evidence context');
    expect(rows[1]).toMatchObject({ active: true, visibility: 'private', forgotten: false });
    expect(rows[2]).toMatchObject({ active: false, forgotten: true, validUntil: '2020-01-01' });
    expect(rows[2].context).toContain('superseded by #9');
    expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(active);
    expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(expired);
    const imported = await preserveWithdrawnFenceRows(engine, sourceId, body);
    expect(imported).toBe(snapshot.page.compiled_truth);
    expect(await preserveWithdrawnFenceRows(engine, sourceId, imported)).toBe(imported);
    await rebuildPendingPageProjections(engine, 100);
    const chunks = await engine.getChunks('legacy-withdrawal', { sourceId });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map(chunk => chunk.chunk_text).join('\n')).not.toContain('withdrawal');
    expect(await engine.searchKeyword('withdrawalcontextsentinel', { sourceId })).toEqual([]);
    expect(await engine.searchKeyword('withdrawalhistorysentinel', { sourceId })).toEqual([]);
  }
});

test('DB-only subjectless withdrawal leaves unrelated pages and chunks unchanged', async () => {
  const isolatedSourceId = 'withdrawal-subjectless-test';
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      await engine.putPage('unrelated', {
        type: 'note',
        title: 'Unrelated page',
        compiled_truth: 'This page has no facts fence.',
      }, { sourceId: isolatedSourceId });
      await engine.upsertChunks('unrelated', [{
        chunk_index: 0,
        chunk_source: 'compiled_truth',
        chunk_text: 'unrelated chunk sentinel',
      }], { sourceId: isolatedSourceId });
      const before = (await engine.readPageSnapshot('unrelated', { sourceId: isolatedSourceId }))!;
      const factRow = await engine.insertFact({
        fact: 'A subjectless DB-only memory',
        source: 'remember',
        visibility: 'world',
      }, { source_id: isolatedSourceId });

      const result = await recordFactWithdrawal(engine, factRow.id, isolatedSourceId, true);

      expect(result).toMatchObject({ withdrawn: true, pages: [] });
      expect(await recordFactWithdrawal(engine, factRow.id, isolatedSourceId, true)).toEqual({ withdrawn: false, pages: [] });
      const blank = await engine.insertFact({ fact: '   ', source: 'legacy', visibility: 'world' }, { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, blank.id, isolatedSourceId, true)).pages).toEqual([]);
      const after = (await engine.readPageSnapshot('unrelated', { sourceId: isolatedSourceId }))!;
      expect(after.revision).toBe(before.revision);
      expect(await engine.executeRaw(
        `SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id
          WHERE p.source_id=$1 AND p.slug='unrelated'`,
        [isolatedSourceId],
      )).toHaveLength(1);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('subjectless withdrawal removes an exact stale chunk even when the page body no longer carries the claim', async () => {
  const isolatedSourceId = 'withdrawal-stale-chunk-test';
  const claim = 'not now';
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      await engine.putPage('stale-projection', { type: 'note', title: 'Stale projection', compiled_truth: 'Current safe body' },
        { sourceId: isolatedSourceId });
      await engine.upsertChunks('stale-projection', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: claim }],
        { sourceId: isolatedSourceId });
      const stored = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });

      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).pages.map(page => page.slug)).toEqual(['stale-projection']);
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)',
        [isolatedSourceId, 'stale-projection'])).toEqual([]);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('withdrawal invalidates a soft-deleted matching page before it can be restored', async () => {
  const isolatedSourceId = 'withdrawal-soft-deleted-test';
  const claim = 'withdrawal soft delete sentinel';
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      await engine.putPage('deleted-fence', {
        type: 'note', title: 'Deleted facts', compiled_truth: renderFactsTable([fact(claim)]),
      }, { sourceId: isolatedSourceId });
      await engine.upsertChunks('deleted-fence', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: claim }],
        { sourceId: isolatedSourceId });
      expect(await engine.softDeletePage('deleted-fence', { sourceId: isolatedSourceId })).not.toBeNull();
      const [before] = await engine.executeRaw<{ knowledge_revision: string }>(
        'SELECT knowledge_revision FROM pages WHERE source_id=$1 AND slug=$2', [isolatedSourceId, 'deleted-fence']);
      const stored = await engine.insertFact({ fact: claim, source: 'test', visibility: 'world' }, { source_id: isolatedSourceId });

      const result = await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true);

      expect(result.pages.map(page => page.slug)).toEqual(['deleted-fence']);
      const [after] = await engine.executeRaw<{ knowledge_revision: string }>(
        'SELECT knowledge_revision FROM pages WHERE source_id=$1 AND slug=$2', [isolatedSourceId, 'deleted-fence']);
      expect(after.knowledge_revision).not.toBe(before.knowledge_revision);
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)',
        [isolatedSourceId, 'deleted-fence'])).toEqual([]);
      expect(await engine.restorePage('deleted-fence', { sourceId: isolatedSourceId })).toBe(true);
      expect(await engine.searchKeyword('withdrawal soft delete sentinel', { sourceId: isolatedSourceId })).toEqual([]);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('candidate prefilter preserves DB whitespace and escaped-pipe fingerprint semantics', async () => {
  const isolatedSourceId = 'withdrawal-prefilter-test';
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      await engine.putPage('matching-fence', {
        type: 'note', title: 'Matching facts', compiled_truth: renderFactsTable([fact('Uses A | B')]),
      }, { sourceId: isolatedSourceId });
      await engine.putPage('unrelated-fence', {
        type: 'note', title: 'Other facts', compiled_truth: renderFactsTable([fact('Keeps this unrelated fact')]),
      }, { sourceId: isolatedSourceId });
      await engine.upsertChunks('matching-fence', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Uses A or B' }],
        { sourceId: isolatedSourceId });
      await engine.upsertChunks('unrelated-fence', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'unrelated fact chunk' }],
        { sourceId: isolatedSourceId });
      const unrelatedBefore = (await engine.readPageSnapshot('unrelated-fence', { sourceId: isolatedSourceId }))!;
      const stored = await engine.insertFact({ fact: '  uses   a | b  ', source: 'legacy', visibility: 'world' },
        { source_id: isolatedSourceId });

      const result = await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true);

      expect(result.pages.map(page => page.slug)).toEqual(['matching-fence']);
      const matching = (await engine.readPageSnapshot('matching-fence', { sourceId: isolatedSourceId }))!;
      expect(await preserveWithdrawnFenceRows(engine, isolatedSourceId, matching.page.compiled_truth)).toBe(matching.page.compiled_truth);
      expect((await engine.readPageSnapshot('unrelated-fence', { sourceId: isolatedSourceId }))!.revision).toBe(unrelatedBefore.revision);
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)',
        [isolatedSourceId, 'unrelated-fence'])).toHaveLength(1);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('malformed, timeline-only and provenance-only candidates remain conservatively invalidated', async () => {
  const isolatedSourceId = 'withdrawal-candidate-shapes-test';
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      const malformedClaim = 'malformed withdrawal sentinel';
      const malformedTimelineClaim = 'malformed chronology withdrawal sentinel';
      const timelineClaim = 'valid timeline withdrawal sentinel';
      const provenanceClaim = 'provenance withdrawal sentinel';
      await engine.putPage('malformed-fence', { type: 'note', title: 'Malformed facts',
        compiled_truth: renderFactsTable([fact(malformedClaim)]).replace('| world |', '| impossible |') }, { sourceId: isolatedSourceId });
      await engine.putPage('timeline-fence', { type: 'note', title: 'Timeline facts', compiled_truth: 'Safe body',
        timeline: renderFactsTable([fact(timelineClaim)]) }, { sourceId: isolatedSourceId });
      await engine.putPage('malformed-timeline-fence', { type: 'note', title: 'Malformed timeline facts', compiled_truth: 'Safe body',
        timeline: renderFactsTable([fact(malformedTimelineClaim)]).replace('| world |', '| impossible |') }, { sourceId: isolatedSourceId });
      await engine.putPage('provenance-only', { type: 'note', title: 'Provenance only', compiled_truth: 'No facts fence' },
        { sourceId: isolatedSourceId });
      const malformed = await engine.insertFact({ fact: malformedClaim, source: 'legacy', visibility: 'world' },
        { source_id: isolatedSourceId });
      const malformedTimeline = await engine.insertFact({ fact: malformedTimelineClaim, source: 'legacy', visibility: 'world' },
        { source_id: isolatedSourceId });
      const timeline = await engine.insertFact({ fact: timelineClaim, source: 'legacy', visibility: 'world' },
        { source_id: isolatedSourceId });
      const provenance = await engine.insertFact({ fact: provenanceClaim, source: 'legacy', visibility: 'world',
        entity_slug: 'provenance-only' }, { source_id: isolatedSourceId });

      expect((await recordFactWithdrawal(engine, malformed.id, isolatedSourceId, true)).pages.map(page => page.slug)).toEqual(['malformed-fence']);
      expect((await recordFactWithdrawal(engine, malformedTimeline.id, isolatedSourceId, true)).pages.map(page => page.slug)).toEqual(['malformed-timeline-fence']);
      expect((await recordFactWithdrawal(engine, timeline.id, isolatedSourceId, true)).pages.map(page => page.slug)).toEqual(['timeline-fence']);
      expect((await recordFactWithdrawal(engine, provenance.id, isolatedSourceId, true)).pages.map(page => page.slug)).toEqual(['provenance-only']);
      expect(await engine.executeRaw(`SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id
        WHERE p.source_id=$1 AND p.slug=ANY($2::text[])`, [isolatedSourceId,
          ['malformed-fence', 'malformed-timeline-fence', 'timeline-fence', 'provenance-only']])).toEqual([]);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('malformed body fallback requires an exact fence-row claim, not a substring', async () => {
  const isolatedSourceId = 'withdrawal-malformed-substring-test';
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      const body = renderFactsTable([fact('quarterly roadmap planning note')]).replace('| fact |', '| impossible |');
      await engine.putPage('malformed-substring', { type: 'note', title: 'Malformed substring', compiled_truth: body },
        { sourceId: isolatedSourceId });
      const before = (await engine.readPageSnapshot('malformed-substring', { sourceId: isolatedSourceId }))!;
      const stored = await engine.insertFact({ fact: 'roadmap', source: 'remember', visibility: 'world' },
        { source_id: isolatedSourceId });

      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).pages).toEqual([]);
      expect((await engine.readPageSnapshot('malformed-substring', { sourceId: isolatedSourceId }))!.revision).toBe(before.revision);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('prepared import refuses a fence whose matching withdrawal committed during preparation', async () => {
  const isolatedSourceId = 'withdrawal-prepared-import-test';
  const claim = 'withdrawal prepared import sentinel';
  const body = `---\ntitle: Prepared withdrawal\ntype: note\n---\n${renderFactsTable([fact(claim)])}`;
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, 'prepared-withdrawal', body, { sourceId: isolatedSourceId, noEmbed: true,
        prepare: async value => { prepared = value; return value.result; } });
      expect(prepared).toBeDefined();
      const stored = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).pages).toEqual([]);

      expect(prepared!.validate).toBeFunction();
      await expect(engine.transaction(tx => prepared!.validate!(tx))).rejects.toThrow('withdrawal changed during import preparation');
      await expect(engine.transaction(tx => prepared!.apply(tx))).rejects.toThrow('withdrawal changed during import preparation');
      expect(await engine.getPage('prepared-withdrawal', { sourceId: isolatedSourceId })).toBeNull();
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('prepared import refuses a timeline fence whose matching withdrawal committed during preparation', async () => {
  const isolatedSourceId = 'withdrawal-prepared-timeline-test';
  const claim = 'withdrawal prepared timeline sentinel';
  const body = `---\ntitle: Prepared timeline withdrawal\ntype: note\n---\nSafe body\n<!-- timeline -->\n${renderFactsTable([fact(claim)])}`;
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, 'prepared-timeline-withdrawal', body, { sourceId: isolatedSourceId, noEmbed: true,
        prepare: async value => { prepared = value; return value.result; } });
      const stored = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).pages).toEqual([]);

      await expect(engine.transaction(tx => prepared!.validate(tx))).rejects.toThrow('withdrawal changed during import preparation');
      expect(await engine.getPage('prepared-timeline-withdrawal', { sourceId: isolatedSourceId })).toBeNull();
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('prepared import refuses an ambiguous fence when the source has a withdrawal ledger', async () => {
  const isolatedSourceId = 'withdrawal-malformed-prepared-test';
  const claim = 'malformed prepared withdrawal sentinel';
  const body = `---\ntitle: Malformed prepared withdrawal\ntype: note\n---\n${renderFactsTable([fact(claim)]).replace('| fact |', '| impossible |')}`;
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, 'malformed-prepared-withdrawal', body, { sourceId: isolatedSourceId, noEmbed: true,
        prepare: async value => { prepared = value; return value.result; } });
      await expect(engine.transaction(tx => prepared!.validate(tx))).resolves.toBeUndefined();
      const privateMatch = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'private' },
        { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, privateMatch.id, isolatedSourceId)).withdrawn).toBe(true);
      await expect(engine.transaction(tx => prepared!.validate(tx))).resolves.toBeUndefined();
      const unrelated = await engine.insertFact({ fact: 'unrelated withdrawn claim', source: 'remember', visibility: 'world' },
        { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, unrelated.id, isolatedSourceId, true)).withdrawn).toBe(true);
      await expect(engine.transaction(tx => prepared!.validate(tx))).resolves.toBeUndefined();
      const stored = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).pages).toEqual([]);

      await expect(engine.transaction(tx => prepared!.validate(tx))).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(engine.transaction(tx => prepared!.validate(tx))).rejects.toThrow('malformed fact fence contains a withdrawn claim');
      expect(await engine.getPage('malformed-prepared-withdrawal', { sourceId: isolatedSourceId })).toBeNull();
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('prepared import accepts inline marker documentation after an unrelated withdrawal', async () => {
  const isolatedSourceId = 'withdrawal-inline-marker-test';
  const body = `---\ntitle: Fence documentation\ntype: note\n---\nUse \`${FACTS_FENCE_BEGIN}\` to begin a facts table.`;
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      const stored = await engine.insertFact({ fact: 'unrelated inline-doc withdrawal', source: 'remember', visibility: 'world' },
        { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).withdrawn).toBe(true);
      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, 'inline-marker-documentation', body, { sourceId: isolatedSourceId, noEmbed: true,
        prepare: async value => { prepared = value; return value.result; } });
      await expect(engine.transaction(tx => prepared!.validate(tx))).resolves.toBeUndefined();
      await expect(engine.transaction(tx => prepared!.apply(tx))).resolves.toBeUndefined();
      expect(await engine.getPage('inline-marker-documentation', { sourceId: isolatedSourceId })).not.toBeNull();
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('an already-struck row inside a malformed fence is neither blocking nor page-affecting', async () => {
  const isolatedSourceId = 'withdrawal-malformed-struck-test';
  const claim = 'malformed struck withdrawal sentinel';
  const struckClaim = 'malformed struck scope sentinel';
  const malformedStruck = (text: string) => renderFactsTable([fact(text)])
    .replace('| fact |', '| impossible |').replace(`| ${text} |`, `| ~~${text}~~ |`);
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      const stored = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).withdrawn).toBe(true);
      const body = `---\ntitle: Malformed struck withdrawal\ntype: note\n---\n${malformedStruck(claim)}`;
      expect(body).toContain(`~~${claim}~~`);
      expect(hasAmbiguousWithdrawalFence(body)).toBe(true);

      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, 'malformed-struck-prepared', body, { sourceId: isolatedSourceId, noEmbed: true,
        prepare: async value => { prepared = value; return value.result; } });
      await expect(engine.transaction(tx => prepared!.validate(tx))).resolves.toBeUndefined();
      expect((await importFromContent(engine, 'malformed-struck', body, { sourceId: isolatedSourceId, noEmbed: true })).status)
        .toBe('imported');
      const active = body.replace(`~~${claim}~~`, claim);
      await expect(importFromContent(engine, 'malformed-active', active, { sourceId: isolatedSourceId, noEmbed: true }))
        .rejects.toThrow('malformed fact fence contains a withdrawn claim');

      await engine.putPage('malformed-struck-scope', { type: 'note', title: 'Malformed struck scope',
        compiled_truth: malformedStruck(struckClaim) }, { sourceId: isolatedSourceId });
      const before = (await engine.readPageSnapshot('malformed-struck-scope', { sourceId: isolatedSourceId }))!;
      const later = await engine.insertFact({ fact: struckClaim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });
      const result = await recordFactWithdrawal(engine, later.id, isolatedSourceId, true);
      expect(result.withdrawn).toBe(true);
      expect(result.pages).toEqual([]);
      expect((await engine.readPageSnapshot('malformed-struck-scope', { sourceId: isolatedSourceId }))!.revision).toBe(before.revision);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('fence markers follow the canonical parser even after prefix text or inline-code formatting', () => {
  const prefixed = `Facts: ${renderFactsTable([fact('prefixed fence claim')])}`;
  expect(withdrawalFenceBlocks(prefixed)).toHaveLength(1);
  expect(withdrawalFenceBlocks(prefixed)[0].parsed).toMatchObject({ warnings: [], facts: [{ claim: 'prefixed fence claim' }] });
  expect(hasAmbiguousWithdrawalFence(prefixed)).toBe(false);
  const documented = `Use \`${FACTS_FENCE_BEGIN}\` to start a table.\nFacts: ${renderFactsTable([fact('documented fence claim')])}`;
  expect(withdrawalFenceBlocks(documented).map(block => block.parsed.facts.map(f => f.claim))).toEqual([['documented fence claim']]);
  expect(hasAmbiguousWithdrawalFence(documented)).toBe(false);
  expect(hasAmbiguousWithdrawalFence(`Inline: \`${FACTS_FENCE_BEGIN} … ${FACTS_FENCE_END}\` is the syntax.`)).toBe(false);
  const inlineFormatted = renderFactsTable([fact('inline-formatted live claim')])
    .replace(FACTS_FENCE_BEGIN, `Docs: \`${FACTS_FENCE_BEGIN}\``);
  expect(parseFactsFence(inlineFormatted).facts.map(f => f.claim)).toEqual(['inline-formatted live claim']);
  expect(withdrawalFenceBlocks(inlineFormatted).flatMap(block => block.parsed.facts.map(f => f.claim)))
    .toEqual(['inline-formatted live claim']);
  const inlineEndFormatted = renderFactsTable([fact('inline-end live claim')])
    .replace(FACTS_FENCE_END, `End: \`${FACTS_FENCE_END}\``);
  expect(parseFactsFence(inlineEndFormatted).facts.map(f => f.claim)).toEqual(['inline-end live claim']);
  expect(withdrawalFenceBlocks(inlineEndFormatted).flatMap(block => block.parsed.facts.map(f => f.claim)))
    .toEqual(['inline-end live claim']);
  expect(hasAmbiguousWithdrawalFence(inlineEndFormatted)).toBe(false);
});

test('a prefixed fence row is overlaid, guarded on import and absent from rebuilt chunks after withdrawal', async () => {
  const isolatedSourceId = 'withdrawal-prefixed-fence-test';
  const claim = 'prefixedfencesentinel withdrawn claim';
  const raced = 'prefixedracesentinel withdrawn claim';
  const prefixed = (text: string) => `Facts: ${renderFactsTable([fact(text)])}`;
  // The canonical parser (not the enumerator under test) decides which rows are live.
  const activeClaims = (body: string) => parseFactsFence(body).facts.filter(f => f.active).map(f => f.claim);
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      await engine.putPage('prefixed-fence', { type: 'note', title: 'Prefixed facts', compiled_truth: prefixed(claim) },
        { sourceId: isolatedSourceId });
      await engine.upsertChunks('prefixed-fence', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: prefixed(claim) }],
        { sourceId: isolatedSourceId });
      const stored = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });

      expect((await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true)).pages.map(page => page.slug)).toEqual(['prefixed-fence']);
      const snapshot = (await engine.readPageSnapshot('prefixed-fence', { sourceId: isolatedSourceId }))!;
      expect(snapshot.page.compiled_truth).toStartWith('Facts: ');
      expect(activeClaims(snapshot.page.compiled_truth)).toEqual([]);
      expect(sanitizeRemoteBody(snapshot.page.compiled_truth)).not.toContain(claim);
      await rebuildPendingPageProjections(engine, 100);
      const chunks = await engine.getChunks('prefixed-fence', { sourceId: isolatedSourceId });
      expect(chunks.length).toBeGreaterThan(0);
      expect(activeClaims(chunks.map(chunk => chunk.chunk_text).join('\n'))).toEqual([]);
      expect(await engine.searchKeyword('prefixedfencesentinel', { sourceId: isolatedSourceId })).toEqual([]);

      const inlineEndClaim = 'inlineendfencesentinel withdrawn claim', inlineEndProse = 'INLINE END PROSE MUST SURVIVE';
      const inlineEnd = (text: string) => renderFactsTable([fact(text)])
        .replace(FACTS_FENCE_END, `Doc: \`${FACTS_FENCE_END}\`\n${inlineEndProse}\n${FACTS_FENCE_END}`);
      await engine.putPage('inline-end-fence', { type: 'note', title: 'Inline end facts', compiled_truth: inlineEnd(inlineEndClaim) },
        { sourceId: isolatedSourceId });
      await engine.upsertChunks('inline-end-fence', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: inlineEnd(inlineEndClaim) }],
        { sourceId: isolatedSourceId });
      const inlineEndFact = await engine.insertFact({ fact: inlineEndClaim, source: 'remember', visibility: 'world' },
        { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, inlineEndFact.id, isolatedSourceId, true)).pages.map(page => page.slug))
        .toEqual(['inline-end-fence']);
      const inlineEndSnapshot = (await engine.readPageSnapshot('inline-end-fence', { sourceId: isolatedSourceId }))!;
      expect(activeClaims(inlineEndSnapshot.page.compiled_truth)).toEqual([]);
      expect(inlineEndSnapshot.page.compiled_truth).toContain(inlineEndProse);
      await rebuildPendingPageProjections(engine, 100);
      const inlineEndChunks = await engine.getChunks('inline-end-fence', { sourceId: isolatedSourceId });
      expect(activeClaims(inlineEndChunks.map(chunk => chunk.chunk_text).join('\n'))).toEqual([]);
      expect(inlineEndChunks.map(chunk => chunk.chunk_text).join('\n')).toContain(inlineEndProse);
      expect(await engine.searchKeyword('inlineendfencesentinel', { sourceId: isolatedSourceId })).toEqual([]);

      const inlineEndFile = `---\ntitle: Inline end import\ntype: note\n---\n${inlineEnd(inlineEndClaim)}`;
      expect((await importFromContent(engine, 'inline-end-import', inlineEndFile,
        { sourceId: isolatedSourceId, noEmbed: true })).status).toBe('imported');
      const inlineEndImported = (await engine.readPageSnapshot('inline-end-import', { sourceId: isolatedSourceId }))!;
      expect(activeClaims(inlineEndImported.page.compiled_truth)).toEqual([]);
      expect(inlineEndImported.page.compiled_truth).toContain(inlineEndProse);

      const file = `---\ntitle: Prefixed import\ntype: note\n---\n${prefixed(claim)}`;
      expect((await importFromContent(engine, 'prefixed-import', file, { sourceId: isolatedSourceId, noEmbed: true })).status).toBe('imported');
      const imported = (await engine.readPageSnapshot('prefixed-import', { sourceId: isolatedSourceId }))!;
      const [storedBody] = await engine.executeRaw<{ compiled_truth: string }>(
        'SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [isolatedSourceId, 'prefixed-import']);
      expect(activeClaims(storedBody.compiled_truth)).toEqual([]);
      expect(activeClaims(imported.page.compiled_truth)).toEqual([]);

      let prepared: PreparedContentImport | undefined;
      await importFromContent(engine, 'prefixed-race', `---\ntitle: Prefixed race\ntype: note\n---\n${prefixed(raced)}`,
        { sourceId: isolatedSourceId, noEmbed: true, prepare: async value => { prepared = value; return value.result; } });
      const racedFact = await engine.insertFact({ fact: raced, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });
      expect((await recordFactWithdrawal(engine, racedFact.id, isolatedSourceId, true)).withdrawn).toBe(true);
      await expect(engine.transaction(tx => prepared!.validate(tx))).rejects.toThrow('withdrawal changed during import preparation');
      await expect(engine.transaction(tx => prepared!.apply(tx))).rejects.toThrow('withdrawal changed during import preparation');
      expect(await engine.getPage('prefixed-race', { sourceId: isolatedSourceId })).toBeNull();
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});

test('withdrawal scope does not depend on the FTS configuration that built stored vectors', async () => {
  const isolatedSourceId = 'withdrawal-fts-config-test';
  // English stems and drops stopwords; the simple configuration does neither.
  const claim = 'The runners were running quickly';
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [isolatedSourceId]);
    try {
      await engine.putPage('timeline-fence', { type: 'note', title: 'Timeline facts', compiled_truth: 'Safe body',
        timeline: renderFactsTable([fact(claim)]) }, { sourceId: isolatedSourceId });
      await engine.putPage('stale-chunk', { type: 'note', title: 'Stale chunk', compiled_truth: 'Current safe body' },
        { sourceId: isolatedSourceId });
      await engine.upsertChunks('stale-chunk', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: claim }],
        { sourceId: isolatedSourceId });
      await engine.putPage('unrelated', { type: 'note', title: 'Unrelated', compiled_truth: 'Runners ran quickly elsewhere' },
        { sourceId: isolatedSourceId });
      await engine.upsertChunks('unrelated', [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Runners ran quickly elsewhere' }],
        { sourceId: isolatedSourceId });
      const unrelated = (await engine.readPageSnapshot('unrelated', { sourceId: isolatedSourceId }))!;
      const stored = await engine.insertFact({ fact: claim, source: 'remember', visibility: 'world' }, { source_id: isolatedSourceId });

      const result = await withEnv({ GBRAIN_FTS_LANGUAGE: 'simple' }, async () => {
        resetFtsLanguageCache();
        try { return await recordFactWithdrawal(engine, stored.id, isolatedSourceId, true); } finally { resetFtsLanguageCache(); }
      });

      expect(result.pages.map(page => page.slug).sort()).toEqual(['stale-chunk', 'timeline-fence']);
      expect(await engine.executeRaw(`SELECT c.id FROM content_chunks c JOIN pages p ON p.id=c.page_id
        WHERE p.source_id=$1 AND p.slug='stale-chunk'`, [isolatedSourceId])).toEqual([]);
      expect((await engine.readPageSnapshot('unrelated', { sourceId: isolatedSourceId }))!.revision).toBe(unrelated.revision);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [isolatedSourceId]);
    }
  }
});
