/**
 * Short-code aliases on the Program Primary Hard root-cause fixture
 * (gbrain-evals#109, copied to test/fixtures/short-code-alias/, invented names).
 *
 * Protects: a company page that says "Also called JOF in my notes" makes `JOF`
 * one of the company's names, so the call note titled "Call with JOF" and the
 * two mails "From: Kofi Aziz (JOF)" link to the company (before: the company's
 * aka list was empty, the call note had no links and each mail linked only to
 * the person). The code links only as written, as a whole token: "Jof", "jof"
 * and "JOFX" do not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { derivedAliases, mentionBrain, mentionLinks, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'short-code-alias');
const PAGES = ['companies/joronex-foods', 'inbox/2026-09-26-aziz-procurement-handoff', 'inbox/2026-10-09-aziz-reschedule', 'meetings/2026-10-10-joronex-call'];

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

async function loadFixture() {
  for (const slug of PAGES) {
    await importFromContent(engine, slug, readFileSync(join(FIXTURE, `${slug}.md`), 'utf8'), { noEmbed: true, forceRechunk: true });
  }
  await page(engine, 'people/kofi-aziz', 'person', 'Kofi Aziz', 'DevOps Manager at Joronex Foods.');
}

describe('short-code alias fixture (gbrain-evals#109)', () => {
  test('JOF becomes the company\'s name; the call note and both mails link to the company', async () => {
    await loadFixture();
    await sweep(engine);
    expect(await derivedAliases(engine, 'companies/joronex-foods')).toEqual(['declared:jof (cs)']);
    const links = await mentionLinks(engine);
    for (const from of ['meetings/2026-10-10-joronex-call', 'inbox/2026-09-26-aziz-procurement-handoff', 'inbox/2026-10-09-aziz-reschedule']) {
      expect(links).toContain(`${from} -> companies/joronex-foods`);
    }
    expect(links).toContain('inbox/2026-09-26-aziz-procurement-handoff -> people/kofi-aziz');
    expect(links).toContain('inbox/2026-10-09-aziz-reschedule -> people/kofi-aziz');
  });

  test('the code matches case-sensitively as a whole token: Jof, jof and JOFX do not link', async () => {
    await loadFixture();
    await page(engine, 'notes/title-case', 'note', 'Lunch notes', 'Jof brought snacks to the meeting.');
    await page(engine, 'notes/lower-case', 'note', 'Scratch', 'we typed jof by mistake');
    await page(engine, 'notes/longer-token', 'note', 'Codes', 'The JOFX build and the xJOF flag are unrelated.');
    await sweep(engine);
    const links = await mentionLinks(engine);
    for (const from of ['notes/title-case', 'notes/lower-case', 'notes/longer-token']) {
      expect(links.filter(l => l.startsWith(`${from} ->`))).toEqual([]);
    }
  });
});
