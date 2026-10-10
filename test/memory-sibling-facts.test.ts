/**
 * Saved facts about an entity that has identity siblings (Cat 40 Hard
 * development round 1): a name both siblings claim resolves for `remember`,
 * and the entity card, recall and search read facts saved under any sibling
 * or the bare subject slug.
 *
 * Protects: `remember` with entity "Widget Co" fell back to a slug no page
 * has (the account sheet and the CRM record both claim the name), so the card
 * showed 0 facts and recall by the CRM slug missed them; agents re-saved and
 * forgot facts, then answered from older documents. Search now puts the named
 * entity's newest saved facts first and follows one redirection ("folded into
 * Kite Co" then Kite Co's corrected code).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resolveEntitySlugWithSource, resolveStrictEntityReference } from '../src/core/entities/resolve.ts';
import { mentionBrain, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
const local = { remote: false, sourceId: 'default', config: { engine: 'pglite' } };

beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); await engine.executeRaw('DELETE FROM facts'); });

async function put(slug: string, type: string, title: string, body: string) {
  await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type, title, tags: [] }), { noEmbed: true, forceRechunk: true });
}
async function call(op: string, args: Record<string, unknown>) {
  const r = await dispatchToolCall(engine, op, args, local as never);
  if (r.isError) throw new Error(r.content[0].text);
  return { json: JSON.parse(r.content[0].text!), text: r.content.map(c => c.text ?? '').join('\n') };
}
const siblings = async () => {
  await put('accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Account: Widget Co. Nickname used by the team: Copper Fox.');
  await put('crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO. Billing contact: Dana Example.');
  await sweep(engine);
};

describe('facts about an entity with identity siblings', () => {
  test('a name both siblings claim resolves to the group (lowest slug), not a slug no page has', async () => {
    await siblings();
    expect(await resolveEntitySlugWithSource(engine, 'default', 'Widget Co')).toMatchObject({ slug: 'accounts/widget-co' });
    expect(await resolveStrictEntityReference(engine, 'default', 'Widget Co')).toMatchObject({ slug: 'accounts/widget-co' });
    await put('companies/other-example', 'company', 'Other Example', 'x');
    await put('people/other-example', 'person', 'Other Example', 'y');
    expect(await resolveStrictEntityReference(engine, 'default', 'Other Example')).toMatchObject({ slug: null, miss: 'ambiguous' });
  });

  test('remember by name links the fact; the card of either sibling and recall by either slug show it, newest first', async () => {
    await siblings();
    const first = await call('remember', { fact: 'Lior Example is the procurement lead at Widget Co.', entity: 'Widget Co', provenance: 'team update' });
    expect(first.json.entity_slug).toBe('accounts/widget-co');
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from) VALUES
      ('default', 'widget-co', 'Older: the Widget Co discount code is DISC-OLD1.', 'fact', 'world', 'team update', now() - interval '2 days')`);
    await call('remember', { fact: 'Correction: Lena Example is now the procurement lead at Widget Co.', entity: 'crm/widget-co', provenance: 'team correction' });
    const card = (await call('entity', { name: 'WGCO' })).json.card;
    expect(card.entity.slug).toBe('crm/widget-co');
    expect(card.active_fact_count).toBe(3);
    expect(card.recent_facts.map((f: { fact: string }) => f.fact)[0]).toContain('Lena Example');
    expect(card.recent_facts.some((f: { entity_slug?: string }) => f.entity_slug === 'widget-co')).toBe(true);
    for (const entity of ['crm/widget-co', 'accounts/widget-co', 'Widget Co']) {
      const facts = (await call('recall', { entity })).json.facts.map((f: { fact: string }) => f.fact);
      expect(facts).toHaveLength(3);
      expect(facts[0]).toContain('Lena Example');
    }
  });

  test('remember without an entity infers the sibling group the text names (no NO_ENTITY, nothing to re-save)', async () => {
    await siblings();
    const r = await call('remember', { fact: 'Widget Co renewal invoices go to the procurement lead from now on.', provenance: 'team decision' });
    expect(r.json.entity_slug).toBe('accounts/widget-co');
    expect(r.json.warnings).toBeUndefined();
  });

  test('save without an entity, re-save with one, then forget the unlinked copy: the fact stays on both sibling cards (dev round 2)', async () => {
    await siblings();
    const claim = 'Correction: Ines Example is now the procurement lead at Widget Co; Lior Example moved to another role.';
    const unlinked = (await call('remember', { items: [{ fact: claim }], provenance: 'team update', infer_entity: false })).json.items[0];
    const linked = (await call('remember', { items: [{ fact: claim, entity: 'crm/widget-co' }], provenance: 'team update' })).json.items[0];
    expect(linked).toMatchObject({ status: 'superseded', superseded_fact_id: unlinked.id });
    const forgot = await dispatchToolCall(engine, 'forget', { id: unlinked.id, reason: 'duplicate without entity' }, local as never);
    expect(forgot.isError).toBe(true);
    expect(forgot.content[0].text).toContain('claim_linked:');
    for (const name of ['WGCO', 'Widget Co', 'Copper Fox']) {
      const card = (await call('entity', { name })).json.card;
      expect(card.recent_facts.map((f: { id: string }) => String(f.id))).toEqual([String(linked.id)]);
    }
  });

  test('context_pack newer mentions (#6362) and sibling facts on the card both hold for a sibling entity', async () => {
    await put('accounts/widget-co', 'account', 'Account sheet: Widget Co', 'Account: Widget Co. Nickname used by the team: Copper Fox.');
    await put('crm/widget-co', 'crm', 'CRM record: Widget Co', 'Account code: WGCO. Billing contact: Dana Example.');
    await engine.executeRaw(`UPDATE pages SET effective_date = '2026-08-01' WHERE slug IN ('accounts/widget-co', 'crm/widget-co')`);
    await call('put_page', { slug: 'inbox/2026-09-20-widget', content: '---\ntitle: "Widget Co renewal"\ntype: note\ndate: "2026-09-20"\n---\nFrom: Dana Example\n\nWidget Co asks to move the renewal to November.\n' });
    await sweep(engine);
    await call('remember', { fact: 'Lior Example is the procurement lead at Widget Co.', entity: 'accounts/widget-co', provenance: 'team update' });
    await call('remember', { fact: 'Correction: Lena Example is now the procurement lead at Widget Co.', entity: 'crm/widget-co', provenance: 'team correction' });
    const packed = (await call('context_pack', { entities: 'WGCO' })).json.cards[0];
    expect(packed.slug).toBe('crm/widget-co');
    expect(packed.newer_mentions.rows.map((r: { slug: string }) => r.slug)).toEqual(['inbox/2026-09-20-widget']);
    const card = (await call('entity', { name: 'WGCO' })).json.card;
    expect(card.active_fact_count).toBe(2);
    expect(card.recent_facts.map((f: { fact: string }) => f.fact)[0]).toContain('Lena Example');
    expect(card.recent_facts.some((f: { entity_slug?: string }) => f.entity_slug === 'accounts/widget-co')).toBe(true);
  });

  test('search names the entity: its saved facts come first, then the facts of an entity they point to', async () => {
    await siblings();
    await put('crm/kite-co', 'crm', 'CRM record: Kite Co', 'Account code: KTCO.');
    await put('mail/old-code', 'email', 'Discount code: Widget Co', 'The discount code on file for Widget Co orders is DISC-OLD9.');
    await sweep(engine);
    await call('remember', { fact: 'Widget Co is being folded into Kite Co; its orders use Kite Co\'s discount code.', entity: 'Widget Co', provenance: 'team update' });
    await call('remember', { fact: 'Correction: the discount code for Kite Co is DISC-NEW2.', entity: 'Kite Co', provenance: 'team correction' });
    const { text } = await call('search', { query: 'Widget Co discount code' });
    const block = text.slice(text.indexOf('Saved facts (remember)'));
    expect(block).toContain('folded into Kite Co');
    expect(block).toContain('DISC-NEW2');
    expect(block).toContain('named in a saved fact about accounts/widget-co');
    expect(block.indexOf('folded into Kite Co')).toBeLessThan(block.indexOf('DISC-NEW2'));
  });
});
