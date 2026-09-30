/**
 * A withdrawal is scoped to the entity whose fact was forgotten. Forgetting
 * one person's "Prefers email" must not expire, strike or block the same
 * claim about anyone else, while it still survives reimport, re-extraction
 * and a rename of the forgotten entity's page. Real PGLite, no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isFactWithdrawn } from '../src/core/facts/withdrawal.ts';
import { readExportPage, readExportWithdrawals } from '../src/core/export-snapshot.ts';

let engine: PGLiteEngine;
let brainDir: string;

const page = (title: string, rows: string) => `---
title: ${title}
type: person
---
# ${title}

Some body text about ${title}.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;
const EMAIL_ROW = '| 1 | Prefers email | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |';

async function put(slug: string, content: string): Promise<void> {
  mkdirSync(join(brainDir, slug.split('/')[0]), { recursive: true });
  writeFileSync(join(brainDir, `${slug}.md`), content, 'utf-8');
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' });
}

async function activeFacts(): Promise<Array<{ entity_slug: string; expired: boolean }>> {
  return engine.executeRaw(`SELECT entity_slug, expired_at IS NOT NULL AS expired FROM facts
    WHERE fact='Prefers email' ORDER BY entity_slug`);
}

async function forgetAlice(): Promise<void> {
  const [alice] = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE entity_slug='people/alice-example'`);
  const result = await forgetFactInFence(engine, Number(alice.id), { reason: 'alice asked' });
  expect(result.ok).toBe(true);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'withdrawal-subject-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
}, 120000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM fact_withdrawals');
  await engine.executeRaw('UPDATE facts SET superseded_by=NULL');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await put('people/alice-example', page('Alice Example', EMAIL_ROW));
  await put('people/bob-example', page('Bob Example', EMAIL_ROW));
  await runExtractFacts(engine, { slugs: ['people/alice-example', 'people/bob-example'] });
});

describe('subject-scoped withdrawal', () => {
  test('forgetting one entity\'s claim leaves the same claim about another entity active', async () => {
    await forgetAlice();
    expect(await activeFacts()).toEqual([
      { entity_slug: 'people/alice-example', expired: true },
      { entity_slug: 'people/bob-example', expired: false },
    ]);
  });

  test('the claim stays rememberable for other entities and blocked for the forgotten one', async () => {
    await forgetAlice();
    expect(await isFactWithdrawn(engine, 'default', 'world', 'prefers   EMAIL', 'people/alice-example')).toBe(true);
    expect(await isFactWithdrawn(engine, 'default', 'world', 'Prefers email', 'people/charlie-example')).toBe(false);
    expect(await isFactWithdrawn(engine, 'default', 'world', 'Prefers email', null)).toBe(false);
  });

  test('reimport and re-extraction keep the other entity\'s row active and its fence unstruck', async () => {
    await forgetAlice();
    const bobFile = readFileSync(join(brainDir, 'people/bob-example.md'), 'utf-8');
    await engine.executeRaw(`UPDATE pages SET content_hash='stale' WHERE slug='people/bob-example'`);
    await importFromContent(engine, 'people/bob-example', bobFile, { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: ['people/alice-example', 'people/bob-example'] });

    const bob = await engine.getPage('people/bob-example', { sourceId: 'default' });
    expect(bob?.compiled_truth).toContain('| Prefers email |');
    expect(bob?.compiled_truth).not.toContain('forgotten:');
    expect((await activeFacts()).find(r => r.entity_slug === 'people/bob-example')?.expired).toBe(false);
    expect((await activeFacts()).find(r => r.entity_slug === 'people/alice-example')?.expired).toBe(true);
  });

  test('Markdown export strikes the claim only on the forgotten entity\'s page', async () => {
    await forgetAlice();
    const withdrawals = await readExportWithdrawals(engine, 'default');
    const exported = async (slug: string) => {
      const [row] = await engine.executeRaw<{ id: string }>(`SELECT id::text AS id FROM pages WHERE slug=$1`, [slug]);
      return (await readExportPage(engine, { id: row.id, source_id: 'default', slug }, withdrawals)).page.compiled_truth;
    };
    expect(await exported('people/alice-example')).toContain('~~Prefers email~~');
    expect(await exported('people/bob-example')).not.toContain('~~Prefers email~~');
  });

  test('the withdrawal follows a rename of the forgotten entity\'s page', async () => {
    await forgetAlice();
    expect(await engine.updateSlug('people/alice-example', 'people/alice-renamed-example', { sourceId: 'default' })).toBe(1);
    expect(await isFactWithdrawn(engine, 'default', 'world', 'Prefers email', 'people/alice-renamed-example')).toBe(true);
    expect(await isFactWithdrawn(engine, 'default', 'world', 'Prefers email', 'people/alice-example')).toBe(false);
  });

  test('a withdrawal recorded before subject scoping still applies to every entity', async () => {
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id, visibility, fact_hash)
      VALUES ('default', 'world', gbrain_fact_fingerprint('Likes tea'))`);
    expect(await isFactWithdrawn(engine, 'default', 'world', 'Likes tea', 'people/bob-example')).toBe(true);
    expect(await isFactWithdrawn(engine, 'default', 'world', 'Likes tea', null)).toBe(true);
  });
});
