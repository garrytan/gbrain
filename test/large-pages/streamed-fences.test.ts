/**
 * GBRA-95: the streamed importer's fence pass (page-body/streamed-fences.ts) on its own.
 *
 * 1. Protects: over any chunking of the input stream the rewrite equals the whole-section transforms on each region
 *    (`preserveWithdrawnFenceRows` strikes a withdrawn row, Tier 1 normalizes a fixable fence) and leaves every byte
 *    outside the regions as it was; a fence region over FENCE_MAX_BYTES, closed or unclosed, refuses
 *    (`FenceRegionTooLarge`) holding no more than the bound plus one input chunk; marker text outside a closed fence
 *    refuses (`FenceNeedsWholeSection`); a coordinated import's residual fence refuses typed invalid_fence
 *    (`FenceRegionRefused`) while a lenient one is kept as written with its warnings, at the section's line numbers.
 *    Page-wide Tier 1 rules match `fenceStep` over the whole page: a timeline fence sharing a row number with the body's
 *    is renumbered as the whole page renumbers it, and a second fence of one kind in a section (which the whole page
 *    merges) holds the file. A remote writer's takes fence, closed or unclosed, refuses `permission_denied`.
 *    `assertNoHiddenFenceRows` (the guard of a remote write the stored body cannot be merged into) refuses a body holding
 *    a takes fence, a non-world facts row, in a quoted fence too, or an unclosed fence, inline or segmented, and admits a
 *    world-only facts fence. A coordinated streamed import whose source gained a withdrawal after its fences were
 *    rewritten refuses `revision_conflict` at publication (the prepared `apply`) and writes nothing.
 * 2. Fails when: a region split across chunks is missed or rewritten twice, bytes between regions change, an oversized
 *    region is read whole before refusing, a residual fence is stored in a coordinated import, the streamed body differs
 *    from whole-page Tier 1 without holding the file, a remote writer adds a takes fence, the guard reads only the first
 *    reader-visible facts fence, or a withdrawal committed during preparation is published past.
 * 3. PGLite (the transforms read the withdrawal ledger); no provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { preserveWithdrawnFenceRows } from '../../src/core/facts/withdrawal.ts';
import { fenceStep } from '../../src/core/fence-repair/tier1.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { FENCE_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { assertNoHiddenFenceRows, FenceNeedsWholeSection, FenceRegionRefused, FenceRegionTooLarge, hiddenFenceContent, streamedFences, streamedFenceWork } from '../../src/core/page-body/streamed-fences.ts';
import { importStreamedMarkdownFile, type StreamedPreparedImport } from '../../src/core/page-body/streamed-import.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { maintenanceAttribution } from '../../src/core/persistence/attribution.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';

const WITHDRAWN = 'Prefers the aisle seat';
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const facts = (rows: string[]) => `${FACTS_FENCE_BEGIN}\n${HEADER}${rows.join('\n')}\n${FACTS_FENCE_END}`;
const row = (n: number, claim: string, confidence = '1.0') => `| ${n} | ${claim} | preference | ${confidence} | world | medium | 2026-01-01 |  | chat |  |`;
const takes = `${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| 1 | Widgets will sell | take | brain | 0.5 | 2026-07 | notes |\n${TAKES_FENCE_END}`;
const prose = (tag: string) => Array.from({ length: 40 }, (_, i) => `Paragraph ${tag} ${i}: notes on the launch plan, pricing and the review café.\n\n`).join('');
const ctx = { pageVisibility: 'world' as const };

let engine: BrainEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
    `INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [WITHDRAWN]), TEST_WRITE_ATTRIBUTION));
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function* chunks(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, Math.min(at + size, bytes.length));
}
async function rewritten(text: string, size: number, mode: 'coordinated' | 'lenient' = 'lenient', region: 'truth' | 'timeline' = 'truth', remote = false) {
  const fences = streamedFences(engine, { sourceId: 'default', slug: 'notes/streamed', pageId: null, mode, ctx, remote });
  const parts: Buffer[] = [];
  for await (const part of fences.rewrite(chunks(Buffer.from(text, 'utf8'), size), region, true)) parts.push(Buffer.from(part));
  return { text: Buffer.concat(parts).toString('utf8'), fields: fences.fields() };
}
/** Both sections through one pass, the body first (as the streamed import stages them). */
async function rewrittenPage(page: { compiled_truth: string; timeline: string }, size: number) {
  const fences = streamedFences(engine, { sourceId: 'default', slug: 'notes/streamed', pageId: null, mode: 'coordinated', ctx, remote: false });
  const out: string[] = [];
  for (const [region, text] of [['truth', page.compiled_truth], ['timeline', page.timeline]] as const) {
    const parts: Buffer[] = [];
    for await (const part of fences.rewrite(chunks(Buffer.from(text, 'utf8'), size), region, true)) parts.push(Buffer.from(part));
    out.push(Buffer.concat(parts).toString('utf8'));
  }
  return { compiled_truth: out[0]!, timeline: out[1]! };
}
async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  throw new Error('the rewrite did not refuse');
}

describe('streamed fence pass', () => {
  test('equals the whole-section transforms over any chunking, bytes outside the regions untouched', async () => {
    const fixable = facts([row(1, 'Walks to work', '90%')]);
    const body = `# Notes\n\n${prose('a')}${facts([row(1, WITHDRAWN), row(2, 'Drinks tea')])}\n\n${prose('b')}${takes}\n\n\`inline code\` and a code block:\n\n\`\`\`\nconst x = 1;\n\`\`\`\n${prose('c')}`;
    const struck = await preserveWithdrawnFenceRows(engine, 'default', body, 'notes/streamed');
    expect(struck).not.toBe(body);
    expect(struck).toContain(`~~${WITHDRAWN}~~`);
    for (const size of [1, 2, 3, 7, 13, 64, 1000, 4096, body.length]) {
      expect({ size, text: (await rewritten(body, size)).text }).toEqual({ size, text: struck });
    }
    const normalized = fenceStep({ compiled_truth: fixable, timeline: '' }, ctx, { normalize: true });
    expect(normalized.status).toBe('normalized');
    const expected = normalized.status === 'normalized' ? normalized.page.compiled_truth : '';
    for (const size of [5, 333]) {
      const out = await rewritten(`${prose('d')}${fixable}\n${prose('e')}`, size);
      expect(out.text).toBe(`${prose('d')}${expected}\n${prose('e')}`);
      expect(out.fields.fences_normalized?.length).toBeGreaterThan(0);
    }
  }, 120_000);

  test('a residual fence refuses a coordinated import and is kept, with warnings at section lines, by a lenient one', async () => {
    const broken = facts([row(1, 'Drinks tea') + ' extra | cells | here |']);
    const body = `${prose('f')}${broken}\n`;
    const lines = prose('f').split('\n').length - 1;
    const refused = await refusalOf(() => rewritten(body, 97, 'coordinated'));
    expect(refused).toBeInstanceOf(FenceRegionRefused);
    expect((refused as FenceRegionRefused).refusal.code).toBe('invalid_fence');
    const kept = await rewritten(body, 97, 'lenient');
    expect(kept.text).toBe(body);
    expect(kept.fields.fence_issues?.length).toBeGreaterThan(0);
    for (const issue of kept.fields.fence_issues ?? []) if (issue.line !== null) expect(issue.line).toBeGreaterThan(lines);
  }, 60_000);

  test('marker text outside a closed fence refuses', async () => {
    for (const body of [`${prose('g')}<!-- gbrain:takes:begin -->\n| 1 | x |\n<!-- gbrain:takes:end -->\n`, `${prose('h')}${FACTS_FENCE_END}\n${prose('i')}`]) {
      expect(await refusalOf(() => rewritten(body, 11))).toBeInstanceOf(FenceNeedsWholeSection);
    }
  }, 60_000);

  test('a remote write refuses while the stored body hides a takes fence or facts rows (quoted or unclosed too), inline or segmented', async () => {
    await engine.setConfig('pages.segmented_storage', 'on');
    const filler = prose('j').repeat(400);
    const privateRow = facts([row(1, 'Drinks tea').replace('| world |', '| private |')]);
    const pages: Record<string, { fence: string; hidden: 'takes' | 'facts' | null }> = {
      'world-only': { fence: facts([row(1, 'Drinks tea')]), hidden: null },
      'private-row': { fence: privateRow, hidden: 'facts' },
      'with-takes': { fence: takes, hidden: 'takes' },
      // Remote reads hide a quoted fence's private rows too; a canonical facts reader skips the quoted fence.
      'quoted-private-row': { fence: `${facts([row(1, 'Walks to work')])}\n\nAn example:\n\n\`\`\`\n${privateRow}\n\`\`\``, hidden: 'facts' },
      // Two quoted fences back to back (their stored regions touch): each is judged on its own.
      'adjacent-quoted': { fence: `An example:\n\n\`\`\`\n${facts([row(1, 'Walks to work')])}${privateRow}\n\`\`\``, hidden: 'facts' },
      // Stored as written with `fences.normalize` off (Tier 1 closes it otherwise); remote reads drop the unclosed tail.
      'unclosed': { fence: `${FACTS_FENCE_BEGIN}\n${HEADER}${row(1, 'Drinks tea')}\n`, hidden: 'facts' },
    };
    for (const [storage, around] of [['segmented', filler], ['inline', 'A short note.']] as const) {
      for (const [name, { fence, hidden }] of Object.entries(pages)) {
        const slug = `notes/${storage}-${name}`;
        await engine.setConfig('fences.normalize', name === 'unclosed' ? 'false' : 'true');
        await importFromContent(engine, slug, `---\ntitle: Remote merge\ntype: note\n---\n\n${around}\n\n${fence}${name === 'unclosed' ? '' : `\n\n${around}`}`, { noEmbed: true, sourceId: 'default' });
        await engine.setConfig('fences.normalize', 'true');
        const [page] = await engine.executeRaw<{ id: number; body_storage: string }>('SELECT id, body_storage FROM pages WHERE slug=$1', [slug]);
        expect([slug, page!.body_storage === 'segmented' ? 'segmented' : 'inline']).toEqual([slug, storage]);
        expect([slug, await hiddenFenceContent(engine, Number(page!.id))]).toEqual([slug, hidden]);
        const outcome = await assertNoHiddenFenceRows(engine, { id: Number(page!.id), slug, source_id: 'default' }).then(() => 'kept', (error: { code?: string }) => error.code);
        expect([slug, outcome]).toEqual([slug, hidden ? 'page_body_segmented' : 'kept']);
      }
    }
  }, 120_000);

  test('page-wide Tier 1 rules: the streamed body equals whole-page fenceStep, or the file is held', async () => {
    const cases = {
      'row number shared by body and timeline': { compiled_truth: `${prose('k')}${facts([row(1, 'Drinks tea')])}\n\n${prose('l')}`, timeline: `- 2026-01-01 Launch\n\n${facts([row(1, 'Walks to work')])}\n` },
      'timeline row past the body rows': { compiled_truth: facts([row(2, 'Drinks tea')]), timeline: facts([row(2, 'Walks to work'), row(1, 'Reads at night')]) },
      'two facts fences in the body': { compiled_truth: `${prose('m')}${facts([row(1, 'Drinks tea')])}\n\n${prose('n')}${facts([row(2, 'Walks to work')])}\n`, timeline: '' },
      'two facts fences in the timeline': { compiled_truth: prose('o'), timeline: `${facts([row(1, 'Drinks tea')])}\n\n- 2026-01-01 Launch\n\n${facts([row(2, 'Walks to work')])}\n` },
    };
    const held: string[] = [];
    for (const [name, page] of Object.entries(cases)) {
      const whole = fenceStep(page, ctx, { normalize: true });
      expect([name, whole.status]).toEqual([name, 'normalized']);
      for (const size of [3, 97, 4096]) {
        const streamed = await rewrittenPage(page, size).catch((error: unknown) => error);
        if (streamed instanceof FenceNeedsWholeSection) { held.push(name); continue; }
        expect({ name, size, page: streamed }).toEqual({ name, size, page: whole.status === 'normalized' ? whole.page : page });
      }
    }
    expect([...new Set(held)]).toEqual(['two facts fences in the body', 'two facts fences in the timeline']);
  }, 120_000);

  test('a remote writer\'s takes fence, closed or unclosed, refuses permission_denied; a trusted writer\'s is kept', async () => {
    for (const body of [`${prose('p')}${takes}\n${prose('q')}`, `${prose('r')}${takes.slice(0, takes.indexOf(TAKES_FENCE_END))}`]) {
      expect(((await refusalOf(() => rewritten(body, 211, 'coordinated', 'truth', true))) as { code?: string }).code).toBe('permission_denied');
      const kept = await rewritten(body, 211, 'lenient', 'truth', false);
      if (body.includes(TAKES_FENCE_END)) expect(kept.text).toBe(body);
      else expect(kept.fields.fences_normalized?.map(fix => fix.class)).toEqual(['close_fence']);
    }
  }, 60_000);

  test('a forget committed while a coordinated streamed import is prepared refuses its publication (revision_conflict)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-streamed-race-'));
    try {
      const claim = 'Keeps a paper notebook';
      const text = `---\ntitle: Race\ntype: note\n---\n\n${prose('s')}${facts([row(1, claim)])}\n\n${prose('t')}`;
      const path = join(dir, 'race.md');
      writeFileSync(path, text);
      const { principal } = await maintenanceAttribution(engine);
      let prepared: StreamedPreparedImport | undefined;
      await importStreamedMarkdownFile(engine, path, 'notes/race.md', { sourceId: 'default', noEmbed: true,
        coordinated: { snapshot: null, sha256: createHash('sha256').update(text).digest('hex'), owner: { kind: 'import', principalKind: principal.kind, principalId: principal.id, baseRevision: null },
          prepare: async value => { prepared = value; return value.result; } } }, statSync(path), await readPageBodyPolicy(engine));
      expect(prepared?.noop).toBe(false);
      await engine.transaction(tx => prepared!.validate(tx));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        `INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES ('default','world','*',gbrain_fact_fingerprint($1))`, [claim]), TEST_WRITE_ATTRIBUTION));
      // Every publisher (the coordinated sync and import, the upload adapter) runs the prepared validate, then its apply, in its
      // publication transaction; the ledger check is in validate, ahead of a rename's own ledger move.
      const refused = await engine.transaction(async tx => { await prepared!.validate(tx); await prepared!.apply(tx); }).then(() => null, (error: { code?: string }) => error.code);
      expect(refused).toBe('revision_conflict');
      expect(await engine.getPage('notes/race', { sourceId: 'default' })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a fence over FENCE_MAX_BYTES, closed or unclosed, refuses holding at most the bound plus one chunk', async () => {
    const CHUNK = 1024 * 1024;
    const line = `| 1 | ${'x'.repeat(1000)} | fact | 1.0 | world | medium |  |  | chat |  |\n`;
    const filler = line.repeat(Math.ceil((FENCE_MAX_BYTES + 1) / line.length));
    for (const body of [`intro\n${FACTS_FENCE_BEGIN}\n${HEADER}${filler}${FACTS_FENCE_END}\nafter\n`, `intro\n${FACTS_FENCE_BEGIN}\n${HEADER}${filler}after\n`]) {
      streamedFenceWork.held = 0;
      const refused = await refusalOf(() => rewritten(body, CHUNK));
      expect(refused).toBeInstanceOf(FenceRegionTooLarge);
      expect(streamedFenceWork.held).toBeGreaterThan(FENCE_MAX_BYTES);
      expect(streamedFenceWork.held).toBeLessThanOrEqual(FENCE_MAX_BYTES + CHUNK);
    }
  }, 120_000);
});
