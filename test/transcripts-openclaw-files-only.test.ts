/**
 * GST-2768 PR 2: an OpenClaw session folder with no live transcript, read while the Gateway is unreachable, still
 * backfills. The folder holds what OpenClaw 2026.10.9 and 2026.11.3 leave beside sessions:
 *
 * - read: `<id>.jsonl.reset.<stamp>`, `<id>.jsonl.deleted.<stamp>.<32 hex>.zst` and `<id>.jsonl.bak.<stamp>`. OpenClaw's
 *   isRetainedSessionTranscriptArchiveName (2026.10.9 dist, transcript-file-names) names these three as "retained
 *   archives and disposable legacy compact backups" of one session, in the live file's line format. Two files of one
 *   session merge into one conversation, each message once.
 * - skipped: `*.migrated`, `*.migrated.<n>` and `<id>.jsonl.pre-doctor-<kind>-repair-<stamp>.bak` (its
 *   isMigrationArchiveArtifactName: "migration rollback archives retained beside their legacy source", the original of a
 *   transcript already imported into the session database the Gateway serves), and `<id>.jsonl.bak-<pid>-<timestamp>`
 *   (docs/cli/doctor/sqlite-maintenance.md: Doctor's recovery copy of a zero-byte transcript). Reading them would
 *   count a conversation twice; the Gateway reads the database copy when it is back.
 *
 * Every value is synthetic. Repo-less PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { ARCHIVE_TIMEZONE_KEY, runTranscriptArchive, setArchiveEnabled, type ArchiveReader } from '../src/core/transcripts/archive.ts';
import { fileReader } from '../src/core/transcripts/archive-readers.ts';
import { discoverTranscriptFiles } from '../src/core/transcripts/discover.ts';
import { openclawGatewayReader, parseGatewayCliOutput } from '../src/core/transcripts/openclaw-gateway.ts';
import { archivedPages, type Turn } from './helpers/transcript-archive.ts';

const root = mkdtempSync(join(tmpdir(), 'openclaw-files-only-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig(ARCHIVE_TIMEZONE_KEY, 'UTC');
  await setArchiveEnabled(engine, true);
});

function sessionText(id: string, turns: Turn[]): string {
  const lines: unknown[] = [{ type: 'session', version: 3, id, timestamp: turns[0]![1], cwd: '/home/alice-example/agent-workspace' }];
  turns.forEach(([role, timestamp, text], i) => lines.push({ type: 'message', id: id + '-m' + i, parentId: i ? id + '-m' + (i - 1) : null, timestamp, message: { role, timestamp, content: [{ type: 'text', text }] } }));
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}
const put = (name: string, text: string) => { const p = join(root, name); writeFileSync(p, name.endsWith('.zst') ? Bun.zstdCompressSync(Buffer.from(text)) : text); return p; };
const HEX = '0123456789abcdef0123456789abcdef';
const SPLIT_A: Turn[] = [['user', '2026-11-05T09:00:00.000Z', 'split one'], ['assistant', '2026-11-05T09:01:00.000Z', 'split two']];
const SPLIT_B: Turn[] = [...SPLIT_A, ['user', '2026-11-06T09:00:00.000Z', 'split three']];

const read = [
  put('s-reset.jsonl.reset.2026-11-03T10-00-00.000Z', sessionText('s-reset', [['user', '2026-11-02T08:00:00.000Z', 'reset day text'], ['assistant', '2026-11-02T08:01:00.000Z', 'reset reply']])),
  put('s-deleted.jsonl.deleted.2026-11-04T10-00-00.000Z.' + HEX + '.zst', sessionText('s-deleted', [['user', '2026-11-03T08:00:00.000Z', 'deleted day text']])),
  put('s-bak.jsonl.bak.2026-11-05T10-00-00Z', sessionText('s-bak', [['user', '2026-11-04T08:00:00.000Z', 'compact backup text']])),
  put('s-split.jsonl.reset.2026-11-05T12-00-00.000Z', sessionText('s-split', SPLIT_A)),
  put('s-split.jsonl.deleted.2026-11-06T12-00-00.000Z.' + HEX + '.zst', sessionText('s-split', SPLIT_B)),
];
const SKIPPED_TEXT = 'SKIPPED-ARTIFACT-TEXT';
const skipped = [
  put('s-mig.jsonl.migrated', sessionText('s-mig', [['user', '2026-11-04T09:00:00.000Z', SKIPPED_TEXT + ' migrated']])),
  put('s-mig2.jsonl.migrated.2', sessionText('s-mig2', [['user', '2026-11-04T09:00:00.000Z', SKIPPED_TEXT + ' migrated 2']])),
  put('s-pre.jsonl.pre-doctor-branch-repair-2026-11-04T09-00-00Z.bak', sessionText('s-pre', [['user', '2026-11-04T09:00:00.000Z', SKIPPED_TEXT + ' pre-doctor']])),
  put('s-zero.jsonl.bak-4242-2026-11-04T09-00-00Z', sessionText('s-zero', [['user', '2026-11-04T09:00:00.000Z', SKIPPED_TEXT + ' doctor recovery']])),
];

const gatewayDown = openclawGatewayReader({ transport: { async call() {
  return parseGatewayCliOutput(JSON.stringify({ ok: false, error: { type: 'gateway_transport_error', message: 'connect ECONNREFUSED 127.0.0.1:18789', details: { kind: 'closed' } } }), 1);
} } }) as unknown as ArchiveReader;
const readers = () => [fileReader({ format: 'openclaw', root, extension: '.jsonl' }), gatewayDown];
const NOW = new Date('2026-11-10T12:00:00Z');
const backfill = () => runTranscriptArchive(engine, { mode: 'backfill', from: '2026-11-01', readers: readers(), now: NOW });

describe('openclaw files-only folder with the Gateway unreachable', () => {
  test('discovery reads the reset, deleted and bak.<stamp> files and skips migration and Doctor copies', () => {
    const found = discoverTranscriptFiles([{ format: 'openclaw', root, extension: '.jsonl' }], { includeArchived: true }).map(d => d.path).sort();
    expect(found).toEqual([...read].sort());
    for (const p of skipped) expect(found).not.toContain(p);
  });

  test('backfill writes every day from the archived files, reports the Gateway, a rerun writes nothing, and a finished day whose source grew is written again', async () => {
    const first = await backfill();
    expect(first.errors.map(e => e.code)).toEqual(['archive_gateway_unreachable']);
    expect(first.days.filter(d => d.status === 'written').map(d => d.day).sort()).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    const pages = (await archivedPages(engine)).filter(p => p.slug.startsWith('conversations/openclaw/'));
    const all = pages.map(p => p.body).join('\n');
    for (const text of ['reset day text', 'reset reply', 'deleted day text', 'compact backup text', 'split three']) expect(all).toContain(text);
    expect(all).not.toContain(SKIPPED_TEXT);
    expect(all.split('split one').length - 1).toBe(1);
    expect(all.split('split two').length - 1).toBe(1);

    const before = await archivedPages(engine);
    const again = await backfill();
    expect(again.written).toBe(0);
    expect(await archivedPages(engine)).toEqual(before);

    put('s-reset.jsonl.reset.2026-11-03T10-00-00.000Z', sessionText('s-reset', [['user', '2026-11-02T08:00:00.000Z', 'reset day text'], ['assistant', '2026-11-02T08:01:00.000Z', 'reset reply'], ['user', '2026-11-02T08:02:00.000Z', 'recovered later']]));
    const refreshed = await backfill();
    expect(refreshed.days.filter(d => d.status === 'written').map(d => d.day)).toEqual(['2026-11-02']);
    expect((await archivedPages(engine)).map(p => p.body).join('\n')).toContain('recovered later');
  }, 120_000);
});
