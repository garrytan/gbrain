/**
 * W9F item 4 (Decision 3): `takes remove` leaves a reservation row, so a
 * removed take's number is never handed out again. Shared by the PGLite unit
 * test and the Postgres E2E so both engines run the same cases through the
 * coordinated takes path (`takes_add`, `takes_supersede`, `takes_remove`).
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall as dispatch } from '../../src/mcp/dispatch.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { extractTakes } from '../../src/core/cycle/extract-takes.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { acceptProposal } from '../../src/core/take-proposals.ts';
import { operations } from '../../src/core/operations.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { assertExportProjectionRoundtrip } from '../../src/core/shared-skills/migration-projection.ts';

export interface ReservationHarness { engine: BrainEngine; cli: LocalRegistration; repo: string }

export function reservationCases(h: () => ReservationHarness) {
  const config = () => ({ engine: h().engine.kind, embedding_disabled: true });
  const call = async (operation: string, params: Record<string, unknown>) => {
    const { engine, cli } = h();
    const result = await withVerifiedLocalRegistration(engine, cli,
      () => dispatch(engine, operation, { request_id: randomUUID(), ...params }, { config: config(), remote: false, sourceId: 'default' }));
    const body = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(`${operation} failed: ${result.content[0].text}`);
    return body as Record<string, unknown>;
  };
  const remove = async (slug: string, rowNum: number) => {
    const { engine, cli } = h();
    const op = operations.find(candidate => candidate.name === 'takes_remove')!;
    return withVerifiedLocalRegistration(engine, cli, () => op.handler({ engine, config: config(), remote: false, sourceId: 'default', dryRun: false,
      logger: { info() {}, warn() {}, error() {} } }, { request_id: randomUUID(), slug, row_num: rowNum })) as Promise<Record<string, unknown>>;
  };
  const file = (slug: string) => readFileSync(join(h().repo, `${slug}.md`), 'utf8');
  const fence = (slug: string) => parseTakesFence(file(slug));
  const stored = async (slug: string) => (await h().engine.executeRaw<{ row_num: number; claim: string }>(
    'SELECT t.row_num, t.claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 ORDER BY t.row_num', [slug])).map(r => [Number(r.row_num), r.claim]);
  const seed = async (slug: string, compiledTruth = `about ${slug}`) => {
    const { engine, repo } = h();
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: compiledTruth }, { sourceId: 'default' });
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const path = join(repo, `${slug}.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags), 'utf8');
  };
  const add = async (slug: string, claim: string) => Number((await call('takes_add', { slug, claim, kind: 'take', holder: 'world' })).row_num);

  return {
    'remove #3 then add takes #4, and the reservation keeps #3 out of takes and the index': async () => {
      const slug = 'notes/reserve-basic';
      await seed(slug);
      for (const claim of ['One', 'Two', 'Three']) await add(slug, claim);
      expect(await remove(slug, 3)).toMatchObject({ row_num: 3, removed: true });
      expect(await add(slug, 'Four')).toBe(4);
      const parsed = fence(slug);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.reservedRowNums).toEqual([3]);
      expect(parsed.takes.map(t => [t.rowNum, t.claim])).toEqual([[1, 'One'], [2, 'Two'], [4, 'Four']]);
      expect(file(slug)).not.toContain('Three');
      expect(file(slug)).toContain('| 3 | ~~(removed)~~ | take | world | 0.0 |  | removed |');
      expect(await stored(slug)).toEqual([[1, 'One'], [2, 'Two'], [4, 'Four']]);
      const page = (await h().engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
      await assertExportProjectionRoundtrip(h().engine, parseMarkdown(file(slug), `${slug}.md`), page.id, 'default');
    },

    'a stored take row number with no fence row is never handed out either': async () => {
      const slug = 'notes/reserve-stored';
      await seed(slug);
      await add(slug, 'One');
      const page = (await h().engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
      await h().engine.executeRaw(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
        VALUES ($1, 7, 'Stale index row', 'take', 'world', 0.5, true)`, [page.id]);
      expect(await add(slug, 'Two')).toBe(8);
    },

    'the reservation survives further adds and supersessions; no number is reused': async () => {
      const slug = 'notes/reserve-chain';
      await seed(slug);
      for (const claim of ['One', 'Two']) await add(slug, claim);
      await remove(slug, 2);
      expect(await add(slug, 'Three')).toBe(3);
      const superseded = await call('takes_supersede', { slug, row_num: 1, claim: 'One, revised' });
      expect(superseded).toMatchObject({ old_row: 1, new_row: 4 });
      await remove(slug, 3);
      expect(await add(slug, 'Five')).toBe(5);
      const parsed = fence(slug);
      expect(parsed.warnings).toEqual([]);
      expect(parsed.reservedRowNums).toEqual([2, 3]);
      expect(parsed.takes.map(t => [t.rowNum, t.claim, t.active])).toEqual([[1, 'One', false], [4, 'One, revised', true], [5, 'Five', true]]);
    },

    'takes rebuild and a canonical import keep the reservation and project no row for it': async () => {
      const slug = 'notes/reserve-rebuild';
      await seed(slug);
      for (const claim of ['One', 'Two']) await add(slug, claim);
      await remove(slug, 2);
      const rebuilt = await extractTakes(h().engine, { source: 'db', slugs: [slug], sourceId: 'default', rebuild: true });
      expect(rebuilt.warnings).toEqual([]);
      expect(await stored(slug)).toEqual([[1, 'One']]);
      await importFromContent(h().engine, slug, file(slug), { noEmbed: true });
      expect(await stored(slug)).toEqual([[1, 'One']]);
      expect(await add(slug, 'Three')).toBe(3);
    },

    'on a page with a facts fence the next take skips every facts row number too': async () => {
      const slug = 'notes/reserve-mixed';
      await seed(slug, [
        'About a mixed page.', '', '## Facts', '', '<!--- gbrain:facts:begin -->', '',
        '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
        '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
        '| 1 | First fact | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |',
        '| 2 | Second fact | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |',
        '<!--- gbrain:facts:end -->',
      ].join('\n'));
      expect(await add(slug, 'One')).toBe(3);
      await remove(slug, 3);
      expect(await add(slug, 'Two')).toBe(4);
      expect(fence(slug).reservedRowNums).toEqual([3]);
    },

    'accept, remove, accept again: the proposal stays settled on its removed row and adds nothing': async () => {
      const slug = 'notes/reserve-accept';
      await seed(slug);
      const { engine, repo } = h();
      const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO take_proposals
        (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, domain, model_id, status)
        VALUES ('default', $1, md5('reserve'), 'test-v1', 'run-test', 'Accepted claim', 'bet', 'world', 0.7, NULL, 'test-model', 'pending') RETURNING id`, [slug]);
      const target = { engine, brainDir: repo, sourceId: 'default', actedBy: 'people/tester', config: config() };
      const { rowNum } = await acceptProposal(target, row.id);
      await remove(slug, rowNum);
      await expect(acceptProposal(target, row.id)).rejects.toThrow(/already 'accepted'/);
      const [proposal] = await engine.executeRaw<{ promoted_row_num: number }>('SELECT promoted_row_num FROM take_proposals WHERE id=$1', [row.id]);
      expect(Number(proposal.promoted_row_num)).toBe(rowNum);
      expect(fence(slug).reservedRowNums).toEqual([rowNum]);
      expect(fence(slug).takes).toEqual([]);
      expect(await add(slug, 'Later claim')).toBe(rowNum + 1);
    },

    'a take removed while its accept settles keeps the proposal pointing at the removed number, never at a new take': async () => {
      const slug = 'notes/reserve-settle';
      await seed(slug);
      const { engine, repo } = h();
      const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO take_proposals
        (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, domain, model_id, status)
        VALUES ('default', $1, md5('settle'), 'test-v1', 'run-test', 'Settling claim', 'bet', 'world', 0.7, NULL, 'test-model', 'pending') RETURNING id`, [slug]);
      const target = { engine, brainDir: repo, sourceId: 'default', actedBy: 'people/tester', config: config() };
      const { rowNum } = await acceptProposal(target, row.id);
      await engine.executeRaw('UPDATE take_proposals SET promoted_row_num = NULL WHERE id = $1', [row.id]);
      await remove(slug, rowNum);
      expect(await add(slug, 'Unrelated claim')).toBe(rowNum + 1);
      expect((await acceptProposal(target, row.id)).rowNum).toBe(rowNum);
      const [proposal] = await engine.executeRaw<{ promoted_row_num: number }>('SELECT promoted_row_num FROM take_proposals WHERE id=$1', [row.id]);
      expect(Number(proposal.promoted_row_num)).toBe(rowNum);
      expect(fence(slug).reservedRowNums).toEqual([rowNum]);
      expect(fence(slug).takes.map(t => [t.rowNum, t.claim])).toEqual([[rowNum + 1, 'Unrelated claim']]);
    },
  };
}
