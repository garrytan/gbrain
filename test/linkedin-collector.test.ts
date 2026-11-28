import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

setDefaultTimeout(30_000);
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { listLinkedInCandidates, parseCsvRows } from '../src/core/linkedin/parser.ts';
import { importLinkedInPosts, syncLinkedInWhitelisted } from '../src/core/linkedin/sync.ts';
import { addLinkedInWhitelistEntry } from '../src/core/linkedin/whitelist.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

function buildLinkedInExportFixture(exportDir: string): void {
  mkdirSync(exportDir, { recursive: true });
  writeFileSync(
    path.join(exportDir, 'Profile.csv'),
    'First Name,Last Name\nKai,Suresh\n',
    'utf8',
  );
  // Real LinkedIn Connections.csv begins with a 3-line Notes preamble.
  writeFileSync(
    path.join(exportDir, 'Connections.csv'),
    [
      'Notes:',
      '"When exporting your connection data, you may notice that some of the email addresses are missing."',
      '',
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Jane,Doe,https://www.linkedin.com/in/janedoe,jane@acme.com,Acme Corp,VP Data,12 Oct 2025',
      'Bob,Smith,https://www.linkedin.com/in/bobsmith,,Beta Inc,Founder,01 Nov 2025',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(exportDir, 'messages.csv'),
    [
      'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER',
      'c1,,Jane Doe,https://www.linkedin.com/in/janedoe,Kai Suresh,https://www.linkedin.com/in/kaisuresh,2026-11-20 18:10:00 UTC,,"Loved the harness post.\nLet us talk semantic layers.",INBOX',
      'c1,,Kai Suresh,https://www.linkedin.com/in/kaisuresh,Jane Doe,https://www.linkedin.com/in/janedoe,2026-11-20 18:25:00 UTC,,Next Tuesday works.,INBOX',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    path.join(exportDir, 'Shares.csv'),
    [
      'Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility',
      '2026-11-25 16:00:00 UTC,https://www.linkedin.com/feed/update/1,"The harness has three layers, and companies should own two of them.",,,MEMBER_NETWORK',
    ].join('\n'),
    'utf8',
  );
}

describe('linkedin collector (whitelist-gated)', () => {
  let tmpDir: string;
  let exportDir: string;
  let whitelistPath: string;
  let engine: BrainEngine;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'gbrain-li-test-'));
    exportDir = path.join(tmpDir, 'export');
    whitelistPath = path.join(tmpDir, 'linkedin-whitelist.json');
    buildLinkedInExportFixture(exportDir);

    const pg = new PGLiteEngine();
    await pg.connect({ database_path: path.join(tmpDir, 'brain.pglite') });
    await pg.initSchema();
    engine = pg;
  });

  afterAll(async () => {
    await engine?.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('RFC-4180 CSV parser handles quoted newlines and escaped quotes', () => {
    const rows = parseCsvRows('a,b\n"hello\n""world""",42\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['hello\n"world"', '42'],
    ]);
  });

  test('parses preamble Connections.csv + messages.csv and syncs only whitelisted contacts', async () => {
    const listed = listLinkedInCandidates({ exportDir, whitelistPath });
    expect(listed.ready).toBe(true);
    expect(listed.total_connections).toBe(2);
    expect(listed.total_matched).toBe(2);

    const jane = listed.candidates.find((c) => c.name === 'Jane Doe');
    expect(jane).toBeDefined();
    expect(jane!.message_count).toBe(2);
    expect(jane!.company).toBe('Acme Corp');

    addLinkedInWhitelistEntry({
      key: jane!.key,
      name: jane!.name,
      url: jane!.url,
      slug: 'jane-doe',
      whitelistPath,
    });

    const run1 = await syncLinkedInWhitelisted(engine, { exportDir, whitelistPath });
    expect(run1.synced.length).toBe(1);
    expect(run1.synced[0]!.person_created).toBe(true);
    expect(run1.synced[0]!.skipped).toBe(false);

    // Non-whitelisted Bob must never get a page.
    expect(await engine.getPage('people/bob-smith')).toBeNull();

    const janePage = await engine.getPage('people/jane-doe');
    expect(janePage?.frontmatter?.visibility).toBe('private');
    expect(janePage?.compiled_truth).toContain('VP Data at Acme Corp');

    // Second sync is idempotent.
    const run2 = await syncLinkedInWhitelisted(engine, { exportDir, whitelistPath });
    expect(run2.synced[0]!.skipped).toBe(true);
  });

  test('imports published LinkedIn posts verbatim into originals/linkedin-posts', async () => {
    const res = await importLinkedInPosts(engine, { exportDir });
    expect(res.ok).toBe(true);
    expect(res.post_count).toBe(1);

    const orig = await engine.getPage('originals/linkedin-posts');
    expect(orig?.type).toBe('original');
    expect(orig?.compiled_truth).toContain('The harness has three layers, and companies should own two of them.');
  });
});
