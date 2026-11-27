/**
 * stampPageTrust and loadPageTrust read two things: the current trust of the facts-fence rows a chunk carries (the
 * typed listFenceRowTrust) and the guest mark of a guest page (`executeRaw`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a capability refusal from either read (an engine that does not serve it refuses it) reaches the caller; any
 *    other read failure keeps the fail-open result (the stored labels for fence rows, an unattributed guest mark).
 *  - Regression: a catch-all would answer a fence chunk with its stored label and a guest page with no mark, which a
 *    reader cannot tell apart from a brain whose rows are unflagged and whose guest notes carry no sender.
 *  - Why existing coverage misses it: fence-chunk-trust-read.test.ts and the guest-notes tests run on SQL engines,
 *    which never refuse `executeRaw`.
 *  - Seam: a fake engine with only `executeRaw`, `readPageTrustRows`, `readRowTrustRows`, `listHeldFenceCells` and
 *    `listFenceRowTrust`, the members these call; `raw` answers both the fence-row read and the guest-mark read.
 */
import { describe, expect, test } from 'bun:test';
import { loadPageTrust, stampPageTrust } from '../src/core/eligibility/stamp.ts';
import type { PageTrustRow } from '../src/core/engine.ts';

const refusal = () => Object.assign(new Error('executeRaw (raw SQL)'), { code: 'engine_capability_missing' });

type Raw = (sql: string, params?: unknown[]) => Promise<unknown[]>;
const fake = (raw: Raw, pages: PageTrustRow[] = []) => ({
  executeRaw: raw as never,
  readPageTrustRows: async () => pages,
  readRowTrustRows: async () => [],
  // Only a hideHeld read (dropHeldFenceRows) calls it; these cases never pass hideHeld.
  listHeldFenceCells: async () => [],
  listFenceRowTrust: (async () => raw('listFenceRowTrust')) as never,
  // The guest-mark read of a guest page's stamp: it fails as `raw` does.
  readGuestMarks: (async () => raw('readGuestMarks')) as never,
});

const page = (over: Partial<PageTrustRow> = {}): PageTrustRow => ({
  id: 1, source_id: 'default', slug: 'people/alice-example', trust_tier: 'operator_curated', write_origin: { channel: 'import' },
  flagged: false, guest: false, precedence: 'curated', byId: true, ...over,
});

const fenceChunk = () => ({
  page_id: 1, source_id: 'default', slug: 'people/alice-example',
  chunk_text: '<!-- gbrain:facts:begin -->\n| # | claim |\n|---|---|\n| 1 | likes tea |\n<!-- gbrain:facts:end -->',
});

describe('stampPageTrust fence rows', () => {
  test('passes a capability refusal of the fence-row read on instead of keeping the stored label', async () => {
    const engine = fake(async () => { throw refusal(); }, [page()]);
    await expect(stampPageTrust(engine, [fenceChunk()])).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });

  test('keeps the stored label when the fence-row read fails another way', async () => {
    const engine = fake(async () => { throw new Error('connection reset'); }, [page()]);
    const [row] = await stampPageTrust(engine, [fenceChunk()]);
    expect(row).toMatchObject({ trust_tier: 'operator_curated', origin: 'import' });
  });

  test('lowers the label to the tier the fence-row read returns', async () => {
    const engine = fake(async () => [{ source_id: 'default', slug: 'people/alice-example', row_num: 1, trust_tier: 'agent_written', flagged: true, contested: null }], [page()]);
    const [row] = await stampPageTrust(engine, [fenceChunk()]);
    expect(row).toMatchObject({ trust_tier: 'agent_written', origin: 'facts-fence', unconfirmed: true });
  });
});

describe('guest marks', () => {
  const guest = page({ guest: true, trust_tier: 'external_untrusted' });

  test('loadPageTrust passes a capability refusal of the guest-mark read on', async () => {
    const engine = fake(async () => { throw refusal(); }, [guest]);
    await expect(loadPageTrust(engine, [{ page_id: 1, slug: guest.slug }])).rejects.toMatchObject({ code: 'engine_capability_missing' });
  });

  test('stampPageTrust passes the same refusal on instead of labeling the page unrecorded', async () => {
    const engine = fake(async () => { throw refusal(); }, [guest]);
    await expect(stampPageTrust(engine, [{ page_id: 1, source_id: 'default', slug: guest.slug, chunk_text: 'a note' }]))
      .rejects.toMatchObject({ code: 'engine_capability_missing' });
  });

  test('leaves a guest page unattributed when the guest-mark read fails another way', async () => {
    const engine = fake(async () => { throw new Error('connection reset'); }, [guest]);
    const { byId } = await loadPageTrust(engine, [{ page_id: 1, slug: guest.slug }]);
    expect(byId.get(1)).toMatchObject({ trust_tier: 'external_untrusted', origin: 'guest' });
    expect(byId.get(1)?.guest).toBeDefined();
  });
});
