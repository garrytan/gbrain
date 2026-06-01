import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { IngestionTestHarness } from '../../src/core/ingestion/test-harness.ts';
import { IphoneBackupSource, uniquifyRenderedSlugs } from '../../src/core/ingestion/sources/iphone-backup.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'iphone-backup', 'backup');

describe('IphoneBackupSource', () => {
  test('declares kind and migration mode', () => {
    const source = new IphoneBackupSource({ backupDir: FIXTURE });
    expect(source.kind).toBe('iphone-backup');
    expect(source.mode).toBe('migration');
  });

  test('emits person and conversation markdown events from the fixture backup', async () => {
    const source = new IphoneBackupSource({ backupDir: FIXTURE, selfName: 'Me' });
    const harness = new IngestionTestHarness();
    await harness.run(source);

    expect(harness.validationErrors).toEqual([]);
    expect(harness.events).toHaveLength(4);
    expect(source.stats.people).toBe(2);
    expect(source.stats.conversations).toBe(2);
    expect(harness.events.map((e) => e.source_kind)).toEqual([
      'iphone-backup',
      'iphone-backup',
      'iphone-backup',
      'iphone-backup',
    ]);
    expect(harness.events.map((e) => e.metadata?.slug)).toContain('people/alice-example');
    expect(harness.events.map((e) => e.metadata?.slug)).toContain('conversations/imessage/alice-example-2024-03');
    expect(harness.events.every((e) => e.content_type === 'text/markdown')).toBe(true);
    expect(harness.events.every((e) => e.untrusted_payload === false)).toBe(true);
    await harness.stop();
  });

  test('honors dry-run without emitting events', async () => {
    const source = new IphoneBackupSource({ backupDir: FIXTURE, dryRun: true });
    const harness = new IngestionTestHarness();
    await harness.run(source);

    expect(harness.events).toHaveLength(0);
    expect(source.stats.emitted).toBe(4);
    await harness.stop();
  });

  test('honors limit across rendered pages', async () => {
    const source = new IphoneBackupSource({ backupDir: FIXTURE, limit: 2 });
    const harness = new IngestionTestHarness();
    await harness.run(source);

    expect(harness.events).toHaveLength(2);
    expect(source.stats.emitted).toBe(2);
    await harness.stop();
  });

  test('deduplicates colliding rendered slugs instead of overwriting later pages', () => {
    const pages = uniquifyRenderedSlugs([
      { slug: 'people/alice-example', content: 'a', content_hash: 'h1', page_type: 'person' },
      { slug: 'people/alice-example', content: 'b', content_hash: 'h2', page_type: 'person' },
      { slug: 'people/alice-example', content: 'c', content_hash: 'h3', page_type: 'person' },
    ]);

    expect(pages.map((page) => page.slug)).toEqual([
      'people/alice-example',
      'people/alice-example-2',
      'people/alice-example-3',
    ]);
  });

  test('healthCheck reports ok after a clean run', async () => {
    const source = new IphoneBackupSource({ backupDir: FIXTURE });
    const harness = new IngestionTestHarness();
    await harness.run(source);

    const health = await source.healthCheck();
    expect(health.status).toBe('ok');
    await harness.stop();
  });

  test('missing stores are audited and reported through warning health', async () => {
    const audit: string[] = [];
    const source = new IphoneBackupSource({
      backupDir: '/fake/backup',
      _existsSync: () => true,
      _openManifest: () => ({
        resolveFile: () => null,
        close: () => {},
      }) as any,
      _appendFileSync: (_path, content) => audit.push(content),
    });
    const harness = new IngestionTestHarness();
    await harness.run(source);

    expect(harness.events).toHaveLength(0);
    expect(source.stats.missingStores).toBe(2);
    expect(audit.join('')).toContain('AddressBook.sqlitedb not found in backup');
    expect(audit.join('')).toContain('sms.db not found in backup');
    const health = await source.healthCheck();
    expect(health.status).toBe('warn');
    await harness.stop();
  });

  test('message caps are audited and reported through warning health', async () => {
    const audit: string[] = [];
    const source = new IphoneBackupSource({
      backupDir: FIXTURE,
      maxMessages: 1,
      _appendFileSync: (_path, content) => audit.push(content),
    });
    const harness = new IngestionTestHarness();
    await harness.run(source);

    expect(source.stats.messagesCapped).toBe(1);
    expect(source.stats.conversations).toBe(0);
    expect(audit.join('')).toContain('message cap reached at 1 row(s)');
    const health = await source.healthCheck();
    expect(health.status).toBe('warn');
    await harness.stop();
  });
});
