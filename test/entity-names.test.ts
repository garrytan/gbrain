/**
 * `entity` with `names` (Cat 40 Hard round 4): several names, codes and
 * aliases resolved in one call, each as a compact row with the page's names,
 * its opening lines and its identity siblings.
 *
 * Protects: a reader holding a list of account codes and nicknames (from
 * handoff mails) resolved them one search at a time and ran out of turns
 * (Opus H1: 13-45 single-name searches per cell). One call now returns every
 * account, its code and nickname, and the lead line that carries its region
 * and owner. Private pages stay hidden from remote callers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { ENTITY_LEAD_CHARS, ENTITY_NAMES_MAX, pageLead } from '../src/core/verbs/entity-names.ts';
import { mentionBrain, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

async function call(args: Record<string, unknown>, remote = true) {
  const r = await dispatchToolCall(engine, 'entity', args, { remote, sourceId: 'default' } as never);
  return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text!) as Record<string, any> };
}

async function accounts() {
  await page(engine, 'accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Account: Widget Co. Nickname used by the team: Copper Fox. Industry: automation. Region: EMEA.');
  await page(engine, 'crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account: Widget Co. Account code: WGCO.\n\nSegment: growth. Region: EMEA.\n\nAccount owner: Dana Example (as of 2025-07-05).');
  await page(engine, 'crm/kite-co', 'crm', 'CRM record: Kite Co', 'Account: Kite Co. Account code: KTCO.\n\nRegion: LATAM.');
  await sweep(engine);
}

describe('entity names[]', () => {
  test('codes and nicknames resolve in one call, with names, lead lines and identity siblings', async () => {
    await accounts();
    const { isError, body } = await call({ names: ['WGCO', 'Copper Fox', 'KTCO', 'Nobody Example'] });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ protocol_version: 1, found: 3, missing: 1 });
    const [wgco, fox, ktco, nobody] = body.results;
    expect(wgco).toMatchObject({ name: 'WGCO', found: true, slug: 'crm/widget-co', title: 'CRM record: Widget Co' });
    expect(wgco.aka).toContain('wgco');
    expect(wgco.lead).toContain('Account owner: Dana Example (as of 2025-07-05).');
    expect(wgco.siblings).toEqual([expect.objectContaining({ slug: 'accounts/widget-co', aka: expect.arrayContaining(['Copper Fox']) })]);
    expect(wgco.siblings[0].lead).toContain('Region: EMEA.');
    expect(fox).toMatchObject({ name: 'Copper Fox', found: true, slug: 'accounts/widget-co' });
    expect(fox.siblings.map((s: { slug: string }) => s.slug)).toEqual(['crm/widget-co']);
    expect(ktco).toMatchObject({ found: true, slug: 'crm/kite-co', lead: 'Account: Kite Co. Account code: KTCO. Region: LATAM.' });
    expect(nobody).toMatchObject({ name: 'Nobody Example', found: false });
    expect(body.results.every((r: Record<string, unknown>) => !('referenced_by' in r) && !('recent_facts' in r))).toBe(true);
  });

  test('duplicates resolve once, in first-seen order', async () => {
    await accounts();
    const { body } = await call({ names: ['KTCO', ' KTCO ', 'WGCO', 'KTCO'] });
    expect(body.results.map((r: { name: string }) => r.name)).toEqual(['KTCO', 'WGCO']);
  });

  test('name with names, an empty list and more than the cap are refused with the call that works', async () => {
    for (const args of [{ name: 'WGCO', names: ['KTCO'] }, { names: [] }, { names: Array.from({ length: ENTITY_NAMES_MAX + 1 }, (_, i) => `N${i}`) }]) {
      const { isError, body } = await call(args);
      expect(isError).toBe(true);
      expect(body.code ?? body.error).toBe('invalid_params');
      expect(body.suggestion).toContain('names: [');
    }
  });

  test('a private page is a miss for a remote caller and found locally', async () => {
    await page(engine, 'crm/secret-co', 'crm', 'CRM record: Secret Co', 'Account code: SCRT.', { frontmatter: { visibility: 'private' } });
    await sweep(engine);
    expect((await call({ names: ['Secret Co'] })).body.results[0]).toMatchObject({ found: false });
    expect((await call({ names: ['Secret Co'] }, false)).body.results[0]).toMatchObject({ found: true, slug: 'crm/secret-co' });
  });

  test('a quarantined page is a miss for a remote caller and found locally, like the single-name card (#5575)', async () => {
    await accounts();
    await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine":{"reason":"junk_pattern","detail":"test","assessed_at":"2026-10-07T00:00:00Z"}}'::jsonb WHERE slug = 'crm/kite-co'`);
    expect((await call({ names: ['KTCO', 'WGCO'] })).body.results.map((r: { found: boolean }) => r.found)).toEqual([false, true]);
    expect((await call({ name: 'Kite Co' })).body.found).toBe(false);
    expect((await call({ names: ['Kite Co'] }, false)).body.results[0]).toMatchObject({ found: true, slug: 'crm/kite-co' });
  });

  test('the lead drops headings and private fences, redacts secrets and is bounded', () => {
    const body = '# Heading\n\nFirst line.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Private note | fact | 1.0 | private | medium | 2026-01-01 |  | test |  |\n<!--- gbrain:facts:end -->\n\nSecond line. ' + 'x'.repeat(400);
    const lead = pageLead(body);
    expect(lead.startsWith('First line.')).toBe(true);
    expect(lead).not.toContain('Private note');
    expect(lead).not.toContain('#');
    expect(lead.length).toBeLessThanOrEqual(ENTITY_LEAD_CHARS);
  });
});
