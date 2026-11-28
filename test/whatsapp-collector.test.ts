import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

setDefaultTimeout(30_000);
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { COREDATA_EPOCH_OFFSET, listWhatsAppCandidates, readWhatsAppMessages } from '../src/core/whatsapp/reader.ts';
import { syncWhatsAppWhitelisted } from '../src/core/whatsapp/sync.ts';
import { addWhatsAppWhitelistEntry, removeWhatsAppWhitelistEntry } from '../src/core/whatsapp/whitelist.ts';

function buildFixtureSqlite(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE ZWACHATSESSION (
      Z_PK INTEGER PRIMARY KEY,
      ZCONTACTJID TEXT,
      ZPARTNERNAME TEXT
    );
    CREATE TABLE ZWAMESSAGE (
      Z_PK INTEGER PRIMARY KEY,
      ZCHATSESSION INTEGER,
      ZMESSAGEDATE REAL,
      ZISFROMME INTEGER,
      ZTEXT TEXT
    );
  `);
  const ts1 = Math.floor(Date.parse('2026-11-25T18:00:00Z') / 1000) - COREDATA_EPOCH_OFFSET;
  const ts2 = Math.floor(Date.parse('2026-11-25T18:05:00Z') / 1000) - COREDATA_EPOCH_OFFSET;
  const ts3 = Math.floor(Date.parse('2026-11-24T10:00:00Z') / 1000) - COREDATA_EPOCH_OFFSET;

  db.exec(`
    INSERT INTO ZWACHATSESSION VALUES (1, '14155550101@s.whatsapp.net', 'Alice Founder');
    INSERT INTO ZWACHATSESSION VALUES (2, '14155550102@s.whatsapp.net', 'Bob Private');
    INSERT INTO ZWACHATSESSION VALUES (3, '120363000001@g.us', 'Weekend Group');
    INSERT INTO ZWAMESSAGE VALUES (10, 1, ${ts1}, 0, 'Let us review the semantic layer spec tomorrow.');
    INSERT INTO ZWAMESSAGE VALUES (11, 1, ${ts2}, 1, 'Sounds good Alice, sending the draft tonight.');
    INSERT INTO ZWAMESSAGE VALUES (12, 2, ${ts3}, 0, 'Do not ingest me unless whitelisted.');
    INSERT INTO ZWAMESSAGE VALUES (13, 3, ${ts3}, 0, 'Group chatter');
  `);
  db.close();
}

describe('whatsapp collector (whitelist-gated)', () => {
  let tmpDir: string;
  let dbPath: string;
  let whitelistPath: string;
  let engine: BrainEngine;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'gbrain-wa-test-'));
    dbPath = path.join(tmpDir, 'ChatStorage.sqlite');
    whitelistPath = path.join(tmpDir, 'whatsapp-whitelist.json');
    buildFixtureSqlite(dbPath);

    const pg = new PGLiteEngine();
    await pg.connect({ database_path: path.join(tmpDir, 'brain.pglite') });
    await pg.initSchema();
    engine = pg;
  });

  afterAll(async () => {
    await engine?.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('lists 1:1 candidates by default and excludes groups unless requested', () => {
    const res = listWhatsAppCandidates({ dbPath, whitelistPath });
    expect(res.total_matched).toBe(2);
    expect(res.whitelisted_count).toBe(0);
    expect(res.candidates.map((c) => c.name)).toContain('Alice Founder');
    expect(res.candidates.map((c) => c.name)).not.toContain('Weekend Group');

    const withGroups = listWhatsAppCandidates({ dbPath, whitelistPath, includeGroups: true });
    expect(withGroups.total_matched).toBe(3);
  });

  test('creates zero pages before whitelisting, then syncs only whitelisted contacts idempotently', async () => {
    const emptySync = await syncWhatsAppWhitelisted(engine, { dbPath, whitelistPath });
    expect(emptySync.whitelisted_count).toBe(0);
    expect(emptySync.synced.length).toBe(0);

    addWhatsAppWhitelistEntry({
      jid: '14155550101@s.whatsapp.net',
      name: 'Alice Founder',
      slug: 'alice-founder',
      category: 'founder',
      whitelistPath,
    });

    const msgs = readWhatsAppMessages({ jid: '14155550101@s.whatsapp.net', dbPath });
    expect(msgs.length).toBe(2);

    // Pre-seed Alice's dossier to verify sync NEVER overwrites an existing living dossier body.
    await importFromContent(
      engine,
      'people/alice-founder',
      '---\ntype: person\ntitle: "Alice Founder"\nvisibility: private\n---\n\n# Alice Founder\n\nCustom hand-authored notes that must survive sync.\n',
      { noEmbed: true },
    );

    const run1 = await syncWhatsAppWhitelisted(engine, { dbPath, whitelistPath, ownerLabel: 'Kai' });
    expect(run1.synced.length).toBe(1);
    expect(run1.synced[0]!.person_created).toBe(false);
    expect(run1.synced[0]!.timeline_added).toBe(true);
    expect(run1.synced[0]!.skipped).toBe(false);

    // Non-whitelisted contact must never exist in the brain.
    expect(await engine.getPage('people/bob-private')).toBeNull();

    // Existing dossier prose preserved; timeline + source page + documented_by link present.
    const alicePage = await engine.getPage('people/alice-founder');
    expect(alicePage?.compiled_truth).toContain('Custom hand-authored notes that must survive sync.');
    const sourcePage = await engine.getPage(run1.synced[0]!.source_slug);
    expect(sourcePage?.frontmatter?.visibility).toBe('private');
    expect(sourcePage?.compiled_truth).toContain('semantic layer spec');

    const timeline = await engine.getTimeline('people/alice-founder');
    expect(timeline.length).toBeGreaterThanOrEqual(1);

    // Second sync is idempotent.
    const run2 = await syncWhatsAppWhitelisted(engine, { dbPath, whitelistPath, ownerLabel: 'Kai' });
    expect(run2.synced[0]!.skipped).toBe(true);

    const removed = removeWhatsAppWhitelistEntry({ jid: '14155550101@s.whatsapp.net', whitelistPath });
    expect(removed.removed).toBe(1);
  });
});
