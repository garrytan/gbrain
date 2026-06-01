import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runImportIphoneCore } from '../../src/commands/import-iphone.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'iphone-backup', 'backup');

describe('gbrain import-iphone PGLite integration', () => {
  test('imports fixture contacts and iMessage conversations as brain pages', async () => {
    const result = await runImportIphoneCore(engine, {
      backupDir: FIXTURE,
      sourceId: 'default',
      sourceTier: 'seed_default',
      selfName: 'Me',
    });

    expect(result.errors).toEqual([]);
    expect(result.pages_imported).toBe(4);
    expect(result.source_stats.people).toBe(2);
    expect(result.source_stats.conversations).toBe(2);

    const person = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(person?.type).toBe('person');
    expect(person?.title).toBe('Alice Example');
    expect(person?.frontmatter.imported_from).toBe('iphone-backup');
    expect(person?.frontmatter.phones).toEqual(['+15550000001']);

    const conversation = await engine.getPage('conversations/imessage/alice-example-2024-03', {
      sourceId: 'default',
    });
    expect(conversation?.type).toBe('conversation');
    expect(conversation?.frontmatter.imported_from).toBe('iphone-backup');
    expect(conversation?.frontmatter.participants).toEqual(['Me', 'Alice Example']);

    const parsed = parseConversation(conversation!.compiled_truth, { page: conversation! });
    expect(parsed.matched_pattern_id).toBe('imessage-slack');
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[0]).toMatchObject({
      speaker: 'Me',
      text: 'did acme-example wire the invoice?',
    });
    expect(parsed.messages[1]).toMatchObject({
      speaker: 'Alice Example',
      text: 'yes, this AM',
    });
    const embedded = await engine.executeRaw<{ embedded_count: number; stamped_count: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE cc.embedding IS NOT NULL) AS embedded_count,
         COUNT(*) FILTER (WHERE p.embedding_signature IS NOT NULL) AS stamped_count
       FROM pages p
       LEFT JOIN content_chunks cc ON cc.page_id = p.id
       WHERE p.source_kind = 'iphone-backup'`,
    );
    expect(Number(embedded[0].embedded_count)).toBe(0);
    expect(Number(embedded[0].stamped_count)).toBe(0);
  }, 60_000);

  test('refuses to overwrite an existing enriched person page', async () => {
    await engine.putPage('people/alice-example', {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'Existing enriched profile that must not be clobbered.',
      timeline: '',
      frontmatter: { source: 'manual' },
    });

    const result = await runImportIphoneCore(engine, {
      backupDir: FIXTURE,
      sourceId: 'default',
      sourceTier: 'seed_default',
      selfName: 'Me',
    });

    expect(result.pages_skipped).toBe(1);
    expect(result.errors.some((e) => e.slug === 'people/alice-example' && e.error.includes('Refusing to overwrite'))).toBe(true);
    const person = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(person?.compiled_truth).toBe('Existing enriched profile that must not be clobbered.');
  }, 60_000);

  test('refuses to overwrite an existing non-iPhone conversation page', async () => {
    await engine.putPage('conversations/imessage/alice-example-2024-03', {
      type: 'conversation',
      title: 'Manual iMessage Summary',
      compiled_truth: 'Manual summary that must not be clobbered.',
      timeline: '',
      frontmatter: { source: 'manual' },
    });

    const result = await runImportIphoneCore(engine, {
      backupDir: FIXTURE,
      sourceId: 'default',
      sourceTier: 'seed_default',
      selfName: 'Me',
    });

    expect(result.pages_skipped).toBe(1);
    expect(result.errors.some((e) => e.slug === 'conversations/imessage/alice-example-2024-03' && e.error.includes('Refusing to overwrite'))).toBe(true);
    const conversation = await engine.getPage('conversations/imessage/alice-example-2024-03', { sourceId: 'default' });
    expect(conversation?.compiled_truth).toBe('Manual summary that must not be clobbered.');
  }, 60_000);

  test('does not overwrite existing iPhone conversations when SMS cap is hit', async () => {
    await runImportIphoneCore(engine, {
      backupDir: FIXTURE,
      sourceId: 'default',
      sourceTier: 'seed_default',
      selfName: 'Me',
    });
    const before = await engine.getPage('conversations/imessage/alice-example-2024-03', { sourceId: 'default' });

    const capped = await runImportIphoneCore(engine, {
      backupDir: FIXTURE,
      sourceId: 'default',
      sourceTier: 'seed_default',
      selfName: 'Me',
      maxMessages: 1,
    });

    expect(capped.source_stats.messagesCapped).toBe(1);
    expect(capped.source_stats.conversations).toBe(0);
    const after = await engine.getPage('conversations/imessage/alice-example-2024-03', { sourceId: 'default' });
    expect(after?.compiled_truth).toBe(before?.compiled_truth);
  }, 60_000);
});
