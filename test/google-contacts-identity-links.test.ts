/**
 * Google Contacts identity links (GST-3609): a contact page joins the one person page with exactly the same email or
 * phone; two or more people wait for the owner; a name alone never links; a rejected pair stays apart; no page is
 * edited; the dry run writes nothing; --unlink undoes every link. Repo-less brain (PGLite).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { listEntityIdentities } from '../src/core/entity-identity.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { GOOGLE_CONTACTS_LINK_ORIGIN, IDENTITY_LINKS_CONFIG_KEY, linkGoogleContacts, unlinkGoogleContactPage } from '../src/core/google/contact-identity.ts';

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-google-contact-links-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('people-b','people-b') ON CONFLICT DO NOTHING");
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('gc','gc','{"kind":"google"}'::jsonb) ON CONFLICT DO NOTHING`);
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const page = (slug: string, title: string, frontmatter: Record<string, unknown>, sourceId = 'default') =>
  engine.putPage(slug, { type: 'person', title, compiled_truth: `${title} notes.`, timeline: '', frontmatter } as never, { sourceId } as never);
const contact = (id: string, title: string, emails: string[], phones: string[] = []) =>
  page(`people/${id}`, title, { google_contact_id: `people/${id}`, emails, ...(phones.length ? { phones } : {}) }, 'gc');
const linkOf = async (slug: string, sourceId: string) => (await listEntityIdentities(engine, { slug, slugSourceId: sourceId })).find(m => m.slug === slug && m.source_id === sourceId) ?? null;
const snapshot = () => engine.executeRaw<{ slug: string; source_id: string; body: string; fm: unknown }>(
  "SELECT slug, source_id, compiled_truth AS body, frontmatter AS fm FROM pages WHERE source_id <> 'gc' ORDER BY source_id, slug");
async function dedupe(args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runDedupe(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

describe('gbrain dedupe link-contacts (Google Contacts)', () => {
  test('dry run counts and writes nothing; --apply links exact email and phone matches only; reviews, reject and --unlink', async () => {
    await page('people/alice-example', 'Alice Example', { email: 'alice@example.invalid' });
    await page('people/bob-example', 'Bob Example', { phones: ['+1 555-555-0100'] });
    await page('people/carol-example', 'Carol Example', { email: 'carol@example.invalid' });
    await page('people/carol-sample', 'Carol Example', { email: 'carol@example.invalid' }, 'people-b');
    await page('people/dana-example', 'Dana Example', { email: 'dana@example.invalid' });
    await contact('c-alice', 'Alice Example', ['Alice@Example.invalid']);
    await contact('c-bob', 'Bob E', [], ['(555) 555-0100']);
    await contact('c-carol', 'Carol Example', ['carol@example.invalid']);
    await contact('c-dana', 'Dana Example', ['dana.other@example.invalid']);
    await contact('c-nobody', 'Nobody Sample', ['nobody@example.invalid']);
    const before = await snapshot();

    const dry = JSON.parse(await dedupe(['link-contacts', '--source', 'gc', '--json']));
    expect(dry).toMatchObject({ mode: 'dry_run', contacts: 5, linked: 2, already_linked: 0, waiting: 1, no_match: 2, rejected: 0, other_writer: 0, unlinked: 0 });
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM entity_identities'))[0]!.n).toBe(0);
    expect((await readSyncStatus(engine, 'gc')).identity_reviews ?? []).toEqual([]);
    expect(await engine.getConfig(IDENTITY_LINKS_CONFIG_KEY)).toBeNull();

    const applied = JSON.parse(await dedupe(['link-contacts', '--source', 'gc', '--apply', '--json']));
    expect(applied).toMatchObject({ mode: 'apply', linked: 2, waiting: 1, no_match: 2, identity_links: 'on' });
    expect(await engine.getConfig(IDENTITY_LINKS_CONFIG_KEY)).toBe('on');
    const alice = await linkOf('people/c-alice', 'gc');
    expect(alice?.established_by).toBe(GOOGLE_CONTACTS_LINK_ORIGIN);
    expect((await linkOf('people/alice-example', 'default'))?.entity_id).toBe(alice!.entity_id);
    expect((await linkOf('people/c-bob', 'gc'))?.entity_id).toBe((await linkOf('people/bob-example', 'default'))?.entity_id);
    for (const slug of ['people/c-carol', 'people/c-dana', 'people/c-nobody']) expect(await linkOf(slug, 'gc')).toBeNull();
    expect(await linkOf('people/dana-example', 'default')).toBeNull();
    const status = await readSyncStatus(engine, 'gc');
    expect(status.identity_reviews!.length).toBe(1);
    expect(status.identity_reviews![0]!.contact_slug).toBe('people/c-carol');
    expect(await snapshot()).toEqual(before);

    const again = JSON.parse(await dedupe(['link-contacts', '--source', 'gc', '--apply', '--json']));
    expect(again).toMatchObject({ linked: 0, already_linked: 2, waiting: 1, unlinked: 0 });

    // The owner records the contact and the person as different people: the link goes now and stays gone.
    const groups = JSON.parse(await dedupe(['--preview', '--json', '--source', 'gc'])).groups as Array<{ id: string; members: Array<{ source_id: string; slug: string }> }>;
    const pair = groups.find(g => g.members.some(m => m.slug === 'people/c-alice') && g.members.some(m => m.slug === 'people/alice-example'))!;
    await dedupe(['reject', pair.id]);
    expect(await linkOf('people/c-alice', 'gc')).toBeNull();
    expect(await linkOf('people/alice-example', 'default')).toBeNull();
    const afterReject = JSON.parse(await dedupe(['link-contacts', '--source', 'gc', '--apply', '--json']));
    expect(afterReject).toMatchObject({ linked: 0, already_linked: 1, rejected: 1 });
    expect(await linkOf('people/c-alice', 'gc')).toBeNull();

    const undone = JSON.parse(await dedupe(['link-contacts', '--source', 'gc', '--unlink', '--json']));
    expect(undone).toMatchObject({ unlinked: 1, identity_links: 'off' });
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM entity_identities'))[0]!.n).toBe(0);
    expect((await readSyncStatus(engine, 'gc')).identity_reviews ?? []).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  test('a sync pass over changed contacts links only those; a removed contact page loses its link; a link another writer made is left alone', async () => {
    await page('people/erin-example', 'Erin Example', { email: 'erin@example.invalid' });
    await page('people/finn-example', 'Finn Example', { email: 'finn@example.invalid' });
    await contact('c-erin', 'Erin Example', ['erin@example.invalid']);
    await contact('c-finn', 'Finn Example', ['finn@example.invalid']);
    expect(await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-erin'] })).toMatchObject({ contacts: 1, linked: 1 });
    expect(await linkOf('people/c-finn', 'gc')).toBeNull();
    await unlinkGoogleContactPage(engine, 'gc', 'people/c-erin');
    expect(await linkOf('people/c-erin', 'gc')).toBeNull();
    expect(await linkOf('people/erin-example', 'default')).toBeNull();

    const { linkEntityIdentity } = await import('../src/core/entity-identity.ts');
    await linkEntityIdentity(engine, { entityId: 'manual-finn', slug: 'people/c-finn', sourceId: 'gc', establishedBy: 'manual' });
    expect(await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-finn'] })).toMatchObject({ other_writer: 1, linked: 0 });
    expect((await linkOf('people/c-finn', 'gc'))?.entity_id).toBe('manual-finn');
  });

  test('reject by a contact group id records only the person and the contact, never a member another writer linked', async () => {
    const { linkEntityIdentity } = await import('../src/core/entity-identity.ts');
    await page('people/jade-example', 'Jade Example', {});
    await page('people/jade-example', 'Jade Example', { email: 'jade@example.invalid' }, 'people-b');
    await linkEntityIdentity(engine, { entityId: 'manual-jade', slug: 'people/jade-example', sourceId: 'default', establishedBy: 'manual', canonical: true });
    await linkEntityIdentity(engine, { entityId: 'manual-jade', slug: 'people/jade-example', sourceId: 'people-b', establishedBy: 'manual' });
    await contact('c-jade', 'Jade Example', ['jade@example.invalid']);
    expect(await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-jade'] })).toMatchObject({ linked: 1 });
    expect((await linkOf('people/c-jade', 'gc'))?.entity_id).toBe('manual-jade');

    const out = JSON.parse(await dedupe(['reject', 'manual-jade', '--json']));
    const members = out.rejected[0].members.map((m: { source_id: string; slug: string }) => `${m.source_id}:${m.slug}`).sort();
    expect(members).toEqual(['default:people/jade-example', 'gc:people/c-jade']);
    expect(await linkOf('people/c-jade', 'gc')).toBeNull();
    expect((await linkOf('people/jade-example', 'people-b'))?.entity_id).toBe('manual-jade');
    expect((await linkOf('people/jade-example', 'default'))?.entity_id).toBe('manual-jade');
    // The email sits on a member that is not the one recorded, and the next sync still keeps the pair apart.
    expect(await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-jade'] })).toMatchObject({ linked: 0, rejected: 1 });
    expect(await linkOf('people/c-jade', 'gc')).toBeNull();

    // A group with no canonical member: the reject still records one person member and the contact, and holds.
    await page('people/kai-example', 'Kai Example', { email: 'kai@example.invalid' });
    await page('people/kai-example', 'Kai Example', {}, 'people-b');
    await linkEntityIdentity(engine, { entityId: 'manual-kai', slug: 'people/kai-example', sourceId: 'default', establishedBy: 'manual' });
    await linkEntityIdentity(engine, { entityId: 'manual-kai', slug: 'people/kai-example', sourceId: 'people-b', establishedBy: 'manual' });
    await contact('c-kai', 'Kai Example', ['kai@example.invalid']);
    expect(await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-kai'] })).toMatchObject({ linked: 1 });
    const kai = JSON.parse(await dedupe(['reject', 'manual-kai', '--json']));
    expect(kai.rejected[0].members.length).toBe(2);
    expect(kai.rejected[0].members.some((m: { slug: string }) => m.slug === 'people/c-kai')).toBe(true);
    expect(await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-kai'] })).toMatchObject({ linked: 0, rejected: 1 });
    expect((await linkOf('people/kai-example', 'people-b'))?.entity_id).toBe('manual-kai');
  });

  test('one matching person whose page has another name waits for the owner instead of linking', async () => {
    await page('people/hank-example', 'Hank Example', { email: 'shared@example.invalid' });
    await page('people/ivy-example', 'Ivy B. Example', { email: 'ivy@example.invalid' });
    await contact('c-grace', 'Grace Sample', ['shared@example.invalid']);
    await contact('c-ivy', 'Ivy Example', ['ivy@example.invalid']);
    await contact('c-hank-address', 'shared@example.invalid', ['shared@example.invalid']);
    const counts = await linkGoogleContacts(engine, 'gc', { apply: true, slugs: ['people/c-grace', 'people/c-ivy', 'people/c-hank-address'] });
    expect(counts).toMatchObject({ contacts: 3, linked: 2, name_disagrees: 1 });
    expect(await linkOf('people/c-grace', 'gc')).toBeNull();
    expect((await linkOf('people/c-ivy', 'gc'))?.entity_id).toBe((await linkOf('people/ivy-example', 'default'))?.entity_id);
    const review = (await readSyncStatus(engine, 'gc')).identity_reviews!.find(r => r.contact_slug === 'people/c-grace')!;
    expect(review).toMatchObject({ needs_human: true, candidates: [{ source_id: 'default', slug: 'people/hank-example' }] });
    expect(review.human_reason).toContain('has another name');
  });

  test('names agree on variants, initials and a missing middle name, and disagree on another person', async () => {
    const { namesAgree } = await import('../src/core/entities/name-variants.ts');
    expect(namesAgree('Bob E', 'Bob Example')).toBe(true);
    expect(namesAgree('Bob Example', 'Robert Example')).toBe(true);
    expect(namesAgree('Alice Example', 'Alice B. Example')).toBe(true);
    expect(namesAgree('A. Example', 'Alice Example')).toBe(true);
    expect(namesAgree('Alice', 'Alice Example')).toBe(true);
    expect(namesAgree('Grace Sample', 'Hank Example')).toBe(false);
    expect(namesAgree('Grace Example', 'Hank Example')).toBe(false);
    expect(namesAgree('Hank', 'Grace Example')).toBe(false);
    expect(namesAgree('grace@example.invalid', 'Hank Example')).toBeNull();
    expect(namesAgree('', 'Hank Example')).toBeNull();
  });

  test('a source that is not a Google source is refused and nothing is written', async () => {
    await expect(dedupe(['link-contacts', '--source', 'people-b'])).rejects.toMatchObject({ code: 'invalid_source' });
    await expect(dedupe(['link-contacts', '--source', 'missing'])).rejects.toMatchObject({ code: 'unknown_source' });
  });
});
