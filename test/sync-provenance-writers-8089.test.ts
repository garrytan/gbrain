/**
 * #8089: the two other writers of a sync import record's disk half follow `syncDiskBytes`' rule (#8071): they record the
 * working file only when it holds the bytes the record says were imported, so a later commit of a newer, uncommitted edit
 * is never matched by bytes the page does not hold.
 *
 * Value: protects=the noop waiver (sync-waivers.ts `waivedProvenance`) and the published no-op (sync-prepare.ts
 * `publishedSyncNoop`) provenance writers; fails_when=either records file bytes whose hash is not the record's raw hash;
 * why_new=#8087 hardened only `syncDiskBytes`, and neither shape was reached by a sync probe (#8089); seam=forced probes: each
 * writer is called directly, the waiver with a frozen entry whose raw hash names an uncommitted edit of the pinned content, the
 * published no-op with its file replaced between preparation and apply over a stub transaction that captures statements;
 * no_claim=that a sync reaches either shape today.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { publishedSyncNoop, type SyncIntent } from '../src/core/persistence/sync-prepare.ts';
import { waivedProvenance, type NoopWaiver, type WaiverCursor, type WaiverEntry } from '../src/core/persistence/sync-waivers.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const checkout = (bytes: string) => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-8089-'));
  roots.push(root);
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes/a.md'), bytes);
  return root;
};
const note = (body: string) => `---\ntype: concept\ntitle: notes/a\n---\n\n${body}\n`;
const PINNED = note('The committed body of notes/a.');
const EDITED = note('An uncommitted edit of notes/a.');
const TARGET = 'a'.repeat(40);
const PARSER = { parser_version: 'v-example', markdown_chunker: 1, schema_pack: null };

describe('#8089 waivedProvenance', () => {
  const waiver = (root: string, content: string, rawHash: string, recordedHash: string) => waivedProvenance({ root } as WaiverCursor,
    { requestId: 'request-a', slug: 'notes/a', pageId: 7, intent: { kind: 'managed_sync_import', path: 'notes/a.md', sourcePath: 'notes/a.md', content, rawHash, target: TARGET } as unknown as SyncIntent } satisfies WaiverEntry,
    { kind: 'import', kernel: [], provenance: { source_id: 'default', incarnation: 'incarnation-a', origin: 'notes/a.md', raw_sha256: recordedHash, working: false, gbrain_version: 'v-example', parser: PARSER } } as NoopWaiver,
    'revision-a');
  const disk = (result: ReturnType<typeof waivedProvenance>) => result ? result.disk_sha256 : result;

  test('a pinned import whose file holds an uncommitted edit records the pinned bytes, not the edit', () => {
    expect(disk(waiver(checkout(EDITED), PINNED, sha256(Buffer.from(EDITED)), sha256(Buffer.from(PINNED))))).toBe(sha256(Buffer.from(PINNED)));
  });

  test('controls: the imported file, a CRLF copy of it and a published no-op\'s working file are recorded as read', () => {
    expect(disk(waiver(checkout(PINNED), PINNED, sha256(Buffer.from(PINNED)), sha256(Buffer.from(PINNED))))).toBe(sha256(Buffer.from(PINNED)));
    const crlf = PINNED.replace(/\n/g, '\r\n');
    expect(disk(waiver(checkout(crlf), PINNED, sha256(Buffer.from(crlf)), sha256(Buffer.from(PINNED))))).toBe(sha256(Buffer.from(crlf)));
    expect(disk(waiver(checkout(EDITED), PINNED, sha256(Buffer.from(EDITED)), sha256(Buffer.from(EDITED))))).toBe(sha256(Buffer.from(EDITED)));
  });

  test('a file without the frozen raw hash is not waived; imported bytes in hand under neither hash record nothing', () => {
    expect(waiver(checkout(EDITED), PINNED, sha256(Buffer.from(PINNED)), sha256(Buffer.from(PINNED)))).toBe(false);
    expect(waiver(checkout(EDITED), PINNED, sha256(Buffer.from(EDITED)), sha256(Buffer.from('other bytes')))).toBeNull();
  });
});

describe('#8089 publishedSyncNoop', () => {
  const run = async (root: string, change?: string) => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const page = { id: 7, slug: 'notes/a', deleted_at: null };
    const tx = {
      readPageSnapshot: async () => ({ revision: 'revision-a', page }),
      executeRaw: async (sql: string, params: unknown[] = []) => { statements.push({ sql, params }); return []; },
    } as unknown as BrainEngine;
    const prepared = publishedSyncNoop({ source_id: 'default', source_incarnation: 'incarnation-a', slug: 'notes/a', request_id: 'request-a' } as never,
      { kind: 'managed_sync_import', path: 'notes/a.md', sourcePath: 'notes/a.md', rawHash: sha256(Buffer.from(EDITED)), target: TARGET } as unknown as SyncIntent,
      root, { revision: 'revision-a', page } as never, null, async () => {}, async () => {});
    if (change !== undefined) writeFileSync(join(root, 'notes/a.md'), change);
    await prepared.apply!(tx);
    return statements.filter(statement => /INSERT INTO op_checkpoints/.test(statement.sql))
      .map(statement => (JSON.parse(String(statement.params[2])) as Array<{ disk_sha256: string | null; raw_sha256: string }>)[0]!);
  };

  test('a file that changed between preparation and apply is not recorded', async () => {
    expect(await run(checkout(EDITED), note('A later edit of notes/a.'))).toEqual([]);
  });

  test('control: the working file the page holds is recorded at apply', async () => {
    expect((await run(checkout(EDITED))).map(record => [record.raw_sha256, record.disk_sha256]))
      .toEqual([[sha256(Buffer.from(EDITED)), sha256(Buffer.from(EDITED))]]);
  });
});
