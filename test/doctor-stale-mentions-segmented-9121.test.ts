/**
 * #9121: doctor's stale_mentions scan read the body columns of a page stored in segments, which are empty, so every
 * mentions link on a large page read as stale and the hint told the user to unlink correct links.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { scanStaleMentions } from '../src/core/by-mention.ts';
import { mentionBrain, page, resetMentionBrain } from './helpers/mention-brain.ts';

const MB = 1024 * 1024;
const LARGE = 'notes/large-log';

function largeNote(mention: string): string {
  const filler = Array.from({ length: Math.ceil((1.5 * MB) / 48) }, (_, i) => `Line ${String(i).padStart(8, '0')} of the running log.`).join('\n\n');
  return `---\ntitle: Large log\ntype: note\n---\n${filler}\n\n${mention}\n`;
}

async function linkMention(engine: PGLiteEngine, from: string, to: string): Promise<void> {
  await engine.addLinksBatch([{ from_slug: from, to_slug: to, link_type: 'mentions', link_source: 'mentions', link_kind: 'plain' }]);
}

describe('stale_mentions on a segmented page (#9121)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetMentionBrain(engine);
    await engine.setConfig('pages.segmented_storage', 'on');
    await page(engine, 'companies/acme-example', 'company', 'Acme Example', 'Acme Example is a company.');
    await page(engine, 'companies/globex-example', 'company', 'Globex Example', 'Globex Example is a company.');
  }, 120_000);

  test('a segmented page whose body still mentions the target reports no stale link', async () => {
    expect((await importFromContent(engine, LARGE, largeNote('Signed with Acme Example today.'), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
    expect((await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [LARGE]))[0]!.body_storage).toBe('segmented');
    await linkMention(engine, LARGE, 'companies/acme-example');
    const scan = await scanStaleMentions(engine);
    expect(scan.linksScanned).toBe(1);
    expect(scan.staleLinks).toBe(0);
  }, 300_000);

  test('a segmented page that no longer mentions the target still reports that link stale', async () => {
    expect((await importFromContent(engine, LARGE, largeNote('Signed with Acme Example today.'), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
    await linkMention(engine, LARGE, 'companies/acme-example');
    await linkMention(engine, LARGE, 'companies/globex-example');
    const scan = await scanStaleMentions(engine);
    expect(scan.staleLinks).toBe(1);
    expect(scan.examples).toEqual([expect.objectContaining({ from: LARGE, to: 'companies/globex-example' })]);
  }, 300_000);
});
