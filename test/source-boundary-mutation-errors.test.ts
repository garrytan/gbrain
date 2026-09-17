/**
 * #4109 — same-source graph mutation diagnostics at the source boundary.
 *
 * `get_page` reads may span the caller's federated grant, but `add_link` /
 * `add_timeline_entry` intentionally write only to the caller's scalar write
 * source. Pre-fix, targeting a page the caller can READ from another granted
 * source hit the engine's exact-source existence check, whose generic Error
 * surfaced over MCP as `internal_error` — intentional source isolation looked
 * like data loss.
 *
 * Pinned behavior:
 *   - a visible foreign endpoint → `permission_denied` naming the readable
 *     source and the client's write source (per endpoint: from / to / page);
 *   - a page outside the read grant → `page_not_found` that never names the
 *     foreign source (same anti-enumeration posture as get_page);
 *   - a soft-deleted foreign page is indistinguishable from absence;
 *   - soft-deleted pages IN the write source keep the existing engine
 *     mutation contract (graph rows may reference them);
 *   - same-source mutations are unchanged;
 *   - the engines report the missing endpoint individually (from vs to) in
 *     lockstep parity, so dispatch can classify mutation-time misses.
 *
 * Runs end to end through `dispatchToolCall` (the path both MCP transports
 * share) against a real PGLiteEngine, per mcp-dispatch-optional-params.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withEnv } from './helpers/with-env.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PageMissingError } from '../src/core/engine-errors.ts';
import { dispatchToolCall as dispatchToolCallImpl } from '../src/mcp/dispatch.ts';
import { runSources } from '../src/commands/sources.ts';
import type { AuthInfo } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-source-boundary-'));
async function dispatchToolCall(...args: Parameters<typeof dispatchToolCallImpl>) {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    try { return await dispatchToolCallImpl(...args); }
    finally { await disposePersistenceConsumer(args[0]); }
  });
}

// Source ids chosen so the foreign one ('privsrc') shares no substring with
// the 'internal_error' envelope code — the no-disclosure assertions below
// check the raw payload text.
const WRITE_SRC = 'shared';
const FOREIGN_SRC = 'privsrc';

const FROM_SLUG = 'topics/sbme-from';
const TO_SHARED = 'topics/sbme-to-shared';
const TO_FOREIGN = 'topics/sbme-to-foreign';
const TL_FOREIGN = 'topics/sbme-tl-foreign';
const DELETED_FOREIGN = 'topics/sbme-deleted-foreign';
const SD_FROM = 'topics/sbme-sd-from';
const SD_TO = 'topics/sbme-sd-to';

function auth(allowedSources: string[]): AuthInfo {
  return { token: 'test-token', clientId: 'gbrain_cl_source_boundary', principal: { kind: 'oauth_client', id: 'gbrain_cl_source_boundary' }, sourceId: WRITE_SRC, scopes: ['read', 'write'], allowedSources };
}

// Grant spans both sources (can READ the foreign page) vs write source only.
const GRANTED = { remote: true, sourceId: WRITE_SRC, auth: auth([WRITE_SRC, FOREIGN_SRC]) };
const UNGRANTED = { remote: true, sourceId: WRITE_SRC, auth: auth([WRITE_SRC]) };

function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

async function seed(slug: string, sourceId: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'concept',
    title: slug,
    compiled_truth: 'source-boundary fixture',
  }, { sourceId });
}

async function countLinks(from: string, to: string): Promise<number> {
  const rows = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = $1 AND t.slug = $2`,
    [from, to],
  );
  return rows[0].count;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_disabled: true }));
  await runSources(engine, ['add', WRITE_SRC, '--no-federated']);
  await runSources(engine, ['add', FOREIGN_SRC, '--no-federated']);
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,federated_read) VALUES('gbrain_cl_source_boundary','Source boundary fixture','read write',$1,$2)`, [WRITE_SRC, [WRITE_SRC, FOREIGN_SRC]]);
  await seed(FROM_SLUG, WRITE_SRC);
  await seed(TO_SHARED, WRITE_SRC);
  await seed(TO_FOREIGN, FOREIGN_SRC);
  await seed(TL_FOREIGN, FOREIGN_SRC);
  await seed(DELETED_FOREIGN, FOREIGN_SRC);
  await engine.softDeletePage(DELETED_FOREIGN, { sourceId: FOREIGN_SRC });
  await seed(SD_FROM, WRITE_SRC);
  await seed(SD_TO, WRITE_SRC);
  await engine.softDeletePage(SD_FROM, { sourceId: WRITE_SRC });
  await engine.softDeletePage(SD_TO, { sourceId: WRITE_SRC });
}, 120_000); // full PGLite schema init can exceed the default hook timeout under suite load

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
}, 30_000);

describe('add_link source-boundary diagnostics (#4109)', () => {
  test('a visible foreign `to` endpoint is permission_denied naming the boundary', async () => {
    const result = await dispatchToolCall(engine, 'add_link', {
      from: FROM_SLUG,
      to: TO_FOREIGN,
      link_type: 'mentions',
    }, GRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'permission_denied',
      message: `add_link to page "${TO_FOREIGN}" is readable from source "${FOREIGN_SRC}" but this client writes to source "${WRITE_SRC}".`,
    });
    expect(await countLinks(FROM_SLUG, TO_FOREIGN)).toBe(0);
  });

  test('a visible foreign `from` endpoint is identified as `from`', async () => {
    const result = await dispatchToolCall(engine, 'add_link', {
      from: TO_FOREIGN,
      to: TO_SHARED,
      link_type: 'mentions',
    }, GRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result).error).toBe('permission_denied');
    expect(payload(result).message).toContain(`add_link from page "${TO_FOREIGN}"`);
    expect(await countLinks(TO_FOREIGN, TO_SHARED)).toBe(0);
  });

  test('a foreign page outside the read grant stays page_not_found without disclosure', async () => {
    const result = await dispatchToolCall(engine, 'add_link', {
      from: FROM_SLUG,
      to: TO_FOREIGN,
      link_type: 'mentions',
    }, UNGRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'page_not_found',
      message: `add_link to page "${TO_FOREIGN}" was not found in writable source "${WRITE_SRC}".`,
    });
    expect(result.content[0]!.text).not.toContain(FOREIGN_SRC);
  });

  test('a soft-deleted foreign page is indistinguishable from absence', async () => {
    const result = await dispatchToolCall(engine, 'add_link', {
      from: FROM_SLUG,
      to: DELETED_FOREIGN,
      link_type: 'mentions',
    }, GRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: 'page_not_found' });
    expect(result.content[0]!.text).not.toContain(FOREIGN_SRC);
  });

  test('soft-deleted pages in the write source preserve the engine mutation contract', async () => {
    const result = await dispatchToolCall(engine, 'add_link', {
      from: SD_FROM,
      to: SD_TO,
      link_type: 'mentions',
    }, GRANTED);

    expect(result.isError).toBeUndefined();
    expect(await countLinks(SD_FROM, SD_TO)).toBe(1);
  });

  test('same-source add_link still reaches the engine', async () => {
    const result = await dispatchToolCall(engine, 'add_link', {
      from: FROM_SLUG,
      to: TO_SHARED,
      link_type: 'mentions',
    }, GRANTED);

    expect(result.isError).toBeUndefined();
    expect(await countLinks(FROM_SLUG, TO_SHARED)).toBe(1);
  });
});

describe('add_timeline_entry source-boundary diagnostics (#4109)', () => {
  const ENTRY = { date: '2026-08-14', summary: 'Reviewed next steps.' };

  test('a visible foreign page is permission_denied naming the boundary', async () => {
    const result = await dispatchToolCall(engine, 'add_timeline_entry', {
      slug: TL_FOREIGN,
      ...ENTRY,
    }, GRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'permission_denied',
      message: `add_timeline_entry page "${TL_FOREIGN}" is readable from source "${FOREIGN_SRC}" but this client writes to source "${WRITE_SRC}".`,
    });
    const entries = await engine.getTimeline(TL_FOREIGN, { sourceId: FOREIGN_SRC });
    expect(entries.length).toBe(0);
  });

  test('a foreign page outside the read grant stays page_not_found without disclosure', async () => {
    const result = await dispatchToolCall(engine, 'add_timeline_entry', {
      slug: TL_FOREIGN,
      ...ENTRY,
    }, UNGRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'page_not_found',
      message: `add_timeline_entry page "${TL_FOREIGN}" was not found in writable source "${WRITE_SRC}".`,
    });
    expect(result.content[0]!.text).not.toContain(FOREIGN_SRC);
  });

  test('same-source add_timeline_entry still reaches the engine', async () => {
    const result = await dispatchToolCall(engine, 'add_timeline_entry', {
      slug: FROM_SLUG,
      ...ENTRY,
    }, GRANTED);

    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({ status: 'ok' });
    const entries = await engine.getTimeline(FROM_SLUG, { sourceId: WRITE_SRC });
    expect(entries.length).toBe(1);
  });
});

describe('engine per-endpoint miss messages (lockstep parity contract)', () => {
  test('addLink identifies a missing `to` endpoint', async () => {
    await expect(
      engine.addLink(FROM_SLUG, 'topics/sbme-missing', '', 'documents', 'manual', undefined, undefined,
        { fromSourceId: WRITE_SRC, toSourceId: WRITE_SRC, originSourceId: WRITE_SRC }),
    ).rejects.toThrow(
      `addLink failed: to page "topics/sbme-missing" (source=${WRITE_SRC}) not found`,
    );
  });

  test('addLink identifies a missing `from` endpoint', async () => {
    await expect(
      engine.addLink('topics/sbme-missing', TO_SHARED, '', 'documents', 'manual', undefined, undefined,
        { fromSourceId: WRITE_SRC, toSourceId: WRITE_SRC, originSourceId: WRITE_SRC }),
    ).rejects.toThrow(
      `addLink failed: from page "topics/sbme-missing" (source=${WRITE_SRC}) not found`,
    );
  });

  test('the miss is typed, not a message-prefix contract', async () => {
    // The ops layer reclassifies by instanceof; a reworded message must not
    // silently disable the reclassification (the #4109 string-matching trap).
    try {
      await engine.addTimelineEntry('topics/sbme-missing', {
        date: '2026-08-14',
        summary: 'never lands',
      }, { sourceId: WRITE_SRC });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PageMissingError);
      expect((e as PageMissingError).endpoint).toBe('page');
      expect((e as PageMissingError).slug).toBe('topics/sbme-missing');
      expect((e as PageMissingError).sourceId).toBe(WRITE_SRC);
    }
  });
});

describe('mutation-time deletion race reclassification (#4109)', () => {
  // A hard delete can land between the ops-layer preflight and the engine
  // mutation. The engine's typed miss must be reclassified into the same
  // caller-facing envelope — deterministically faked here since a real race
  // needs a second writer (covered against real Postgres by
  // test/e2e/source-boundary-mutation-postgres.test.ts).
  type StoredPage = { slug: string; source_id: string };

  function fakeEngine(pages: StoredPage[], raceDeleteSlug: string) {
    return {
      async getPage(slug: string, opts: { sourceId?: string; sourceIds?: string[] } = {}) {
        const sources = opts.sourceIds ?? (opts.sourceId ? [opts.sourceId] : []);
        const page = pages.find(
          (candidate) => candidate.slug === slug && sources.includes(candidate.source_id),
        );
        return page ? ({ ...page } as never) : null;
      },
      async addLink(from: string, to: string) {
        const endpoint = raceDeleteSlug === from ? 'from' : 'to';
        pages.splice(pages.findIndex((page) => page.slug === raceDeleteSlug), 1);
        throw new PageMissingError('addLink', endpoint, raceDeleteSlug, WRITE_SRC);
      },
      async addTimelineEntry(slug: string) {
        pages.splice(pages.findIndex((page) => page.slug === raceDeleteSlug), 1);
        throw new PageMissingError('addTimelineEntry', 'page', slug, WRITE_SRC);
      },
      // DB-only brain: no source local_path / repo_path, so the timeline
      // write-through takes its handled:false path and the op falls through
      // to the insert.
      async executeRaw() {
        return [];
      },
      async getConfig() {
        return null;
      },
    } as unknown as BrainEngine;
  }

  test('add_link reclassifies an endpoint hard-deleted after preflight', async () => {
    const eng = fakeEngine(
      [{ slug: 'topics/race-from', source_id: WRITE_SRC }, { slug: 'topics/race-to', source_id: WRITE_SRC }],
      'topics/race-to',
    );
    const result = await dispatchToolCall(eng, 'add_link', {
      from: 'topics/race-from',
      to: 'topics/race-to',
    }, UNGRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'page_not_found',
      message: `add_link to page "topics/race-to" was not found in writable source "${WRITE_SRC}".`,
    });
  });

  test('add_timeline_entry refuses a page replaced after the accepted snapshot', async () => {
    const slug = 'topics/race-tl';
    await seed(slug, WRITE_SRC);
    const original = engine.readPageSnapshot;
    let replaced = false;
    let targetReads = 0;
    engine.readPageSnapshot = async function (target, opts) {
      const snapshot = await original.call(this, target, opts);
      // The first read is the source-boundary preflight; the second is the
      // snapshot whose page identity admission retains in the durable row.
      if (target === slug && ++targetReads === 2) {
        replaced = true;
        await engine.deletePage(slug, { sourceId: WRITE_SRC });
        await seed(slug, WRITE_SRC);
      }
      return snapshot;
    };
    try {
      const result = await dispatchToolCall(engine, 'add_timeline_entry', {
        slug, date: '2026-08-14', summary: 'must not reach the replacement page',
      }, UNGRANTED);
      expect(replaced).toBe(true);
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ write_error: 'page_identity_changed', write_request: { state: 'conflict' } });
      expect(await engine.getTimeline(slug, { sourceId: WRITE_SRC })).toEqual([]);
      expect((await engine.getPage(slug, { sourceId: WRITE_SRC }))?.compiled_truth).toBe('source-boundary fixture');
    } finally { engine.readPageSnapshot = original; }
  });

  test('a page restored between reclassification reads still misses deterministically', async () => {
    // The engine miss fired, but by the time the reclassifier re-reads, the
    // page is back (delete + restore race): never internal_error.
    const eng = {
      async getPage(slug: string) {
        return { slug, source_id: WRITE_SRC } as never;
      },
      async addLink() {
        throw new PageMissingError('addLink', 'to', 'topics/race-restored', WRITE_SRC);
      },
      async executeRaw() { return []; }, // explicitly unmanaged fixture
    } as unknown as BrainEngine;
    const result = await dispatchToolCall(eng, 'add_link', {
      from: 'topics/race-from',
      to: 'topics/race-restored',
    }, UNGRANTED);

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({
      error: 'page_not_found',
      message: `add_link to page "topics/race-restored" was unavailable in writable source "${WRITE_SRC}" during the mutation.`,
    });
  });
});
