/**
 * Unattended enrichment of the owner's Apple Contacts from their own brain (plan GST-3278, PR 2, decisions D2, D3, D5).
 * After a pull that finished cleanly, one batch goes to GBrain Helper's write route with the enrichment token
 * (`requested_by: "enrich"`, which the helper limits to create, fill, add_value and group_add):
 *
 *   - an empty company or job title on a card linked to exactly one person page is filled from that page: its
 *     frontmatter `company` / `role` or a `Company:` / `Job title:` fact another writer left there (never this
 *     source's own rows, so a card's value is never echoed back to it); two different values fill nothing;
 *   - a confirmed email or phone is added beside the card's own: one from a Google Contacts page that shares an exact
 *     email or phone with that card alone (and the card is not linked to two people), or from a still-valid fact on the
 *     linked person page that is wholly `Email: <address>` or `Phone: <number>` and that the owner confirmed, curated or
 *     stated themselves (`content_origin user_said`); never a value another card holds;
 *   - only with `apple_contacts.enrich.create_cards` = true (default false: the owner is shrinking the address book),
 *     a new card, at most 10 a run (the helper allows 50 a day), for a Google Contacts entry no card shares a value with
 *     whose email or phone matches exactly one person page; the helper files it in "Added by GBrain".
 *
 * Nothing here changes or removes a value already on a card; the helper refuses a fill on a field that is not empty.
 * Values come from the brain only, never an outside service. `apple_contacts.enrich` = dry_run records what would be
 * sent and sends nothing; on also needs `apple_contacts.write` = on and the 0600 token file in
 * `apple_contacts.write_token_file`. Each run's outcome is one op_checkpoints row, read by
 * `gbrain apple-contacts enrich status`; it holds card ids, fields and source pages, and no email or phone.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { canonicalPhone } from '../phone-key.ts';
import { identityEmailKey } from '../ops/whois.ts';
import { CONNECTOR_KINDS_SQL } from '../persistence/connector-kinds.ts';
import { USER_SAID_ORIGIN_MARKER } from '../trust/tier.ts';
import { APPLE_CONTACT_ID_KEY, type AppleContactsSourceConfig } from './types.ts';
import { exactPersonMatches } from './identity-match.ts';
import { personFactSource, safePersonFields } from './person-facts.ts';
import { readWriteToken, sendContactsBatch, WRITE_CONFIG_KEY, type ContactsWriteChange, type ContactsWriteReply } from '../apple/contacts-write-client.ts';

export const ENRICH_CONFIG_KEY = 'apple_contacts.enrich';
export const WRITE_TOKEN_FILE_CONFIG_KEY = 'apple_contacts.write_token_file';
export const CREATE_CARDS_CONFIG_KEY = 'apple_contacts.enrich.create_cards';
/** op_checkpoints row (fingerprint = source id): the last enrichment run, as the one element of completed_keys. */
export const APPLE_CONTACTS_ENRICH_OP = 'apple-contacts-enrich';
export const ENRICH_MAX_CHANGES = 200;
export const ENRICH_MAX_CREATES = 10;

type Ref = { source_id: string; slug: string };
export interface EnrichProposal { change: ContactsWriteChange; from: Ref }
export interface EnrichRecord {
  at: string;
  mode: 'dry_run' | 'on';
  sent: boolean;
  /** Why a run in mode on sent nothing, or what stopped it. */
  note: string | null;
  batch: string | null;
  changes: Array<{ key: string; op: string; card: string | null; field: string | null; value: string | null; from: string; status: string; reason: string | null }>;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const json = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } }
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
};
const sha = (parts: string[], n: number) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, n);
const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_RE = /^\+?[\d ().-]{7,}$/;

/** Every enrichment change for this source, in send order (fills, then added values, then new cards), within the caps. */
export async function proposeEnrichment(engine: BrainEngine, sourceId: string, countryCode: string): Promise<EnrichProposal[]> {
  const createCards = ['true', 'on'].includes(String(await engine.getConfig(CREATE_CARDS_CONFIG_KEY).catch(() => null) ?? '').trim().toLowerCase());
  const cards = (await engine.executeRaw<{ id: number; slug: string; frontmatter: unknown }>(
    `SELECT id, slug, frontmatter FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter ? '${APPLE_CONTACT_ID_KEY}' ORDER BY slug`, [sourceId]))
    .map(row => { const fm = json(row.frontmatter); return { pageId: row.id, slug: row.slug, id: String(fm[APPLE_CONTACT_ID_KEY]), emails: list(fm.emails), phones: list(fm.phones),
      company: text(fm.company), role: text(fm.role) }; });
  const emailKey = (v: string) => identityEmailKey(v);
  const phoneKey = (v: string) => canonicalPhone(v, countryCode);
  const keysOf = (emails: string[], phones: string[]) => [...emails.map(e => emailKey(e) && 'e:' + emailKey(e)), ...phones.map(p => phoneKey(p) && 'p:' + phoneKey(p))]
    .filter((k): k is string => !!k);
  const holders = new Map<string, Set<string>>();
  for (const card of cards) for (const k of keysOf(card.emails, card.phones)) holders.set(k, new Set([...holders.get(k) ?? [], card.id]));

  const links = await engine.executeRaw<{ card_page: number; source_id: string; slug: string; frontmatter: unknown }>(
    `SELECT DISTINCT ec.page_id AS card_page, p.source_id, p.slug, p.frontmatter
       FROM entity_identities ec
       JOIN entity_identities ep ON ep.entity_id = ec.entity_id AND ep.page_id <> ec.page_id
       JOIN pages p ON p.id = ep.page_id AND p.deleted_at IS NULL AND p.type = 'person'
       JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE AND COALESCE(s.config->>'kind','') NOT IN (${CONNECTOR_KINDS_SQL})
      WHERE ec.source_id = $1`, [sourceId]);
  const personOf = new Map<number, Array<{ ref: Ref; fm: Record<string, unknown> }>>();
  for (const l of links) personOf.set(l.card_page, [...personOf.get(l.card_page) ?? [], { ref: { source_id: l.source_id, slug: l.slug }, fm: json(l.frontmatter) }]);

  const fills: EnrichProposal[] = [], adds: EnrichProposal[] = [], creates: EnrichProposal[] = [];
  const added = new Set<string>();
  const addValue = (card: string, field: 'emails' | 'phones', value: string, from: Ref) => {
    const k = field === 'emails' ? emailKey(value) && 'e:' + emailKey(value) : phoneKey(value) && 'p:' + phoneKey(value);
    if (!k || holders.has(k) || added.has(k)) return;
    added.add(k);
    adds.push({ change: { key: 'enr-' + sha(['add_value', card, field, k], 40), op: 'add_value', id: card, field, value }, from });
  };

  /** The company and job title a person page gives, each only when every source of it agrees. */
  const personFields = async (person: { ref: Ref; fm: Record<string, unknown> }) => {
    const facts = await engine.executeRaw<{ fact: string; trust_tier: string | null; write_origin: unknown }>(
      `SELECT fact, trust_tier, write_origin FROM facts WHERE source_id=$1 AND entity_slug=$2 AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND source NOT LIKE 'apple-contacts:%' AND source <> $3`,
      [person.ref.source_id, person.ref.slug, personFactSource(sourceId)]);
    const one = (values: Array<string | null>) => { const set = new Set(values.filter((v): v is string => !!v)); return set.size === 1 ? [...set][0]! : null; };
    const claim = (prefix: string) => facts.map(f => f.fact.startsWith(prefix) ? text(f.fact.slice(prefix.length)) : null);
    const confirmed = facts.filter(f => f.trust_tier === 'user_confirmed' || f.trust_tier === 'operator_curated'
      || (f.trust_tier === 'agent_written' && json(f.write_origin).content_origin === USER_SAID_ORIGIN_MARKER));
    return {
      company: one([text(person.fm.company), ...claim('Company: ')]), jobTitle: one([text(person.fm.role), ...claim('Job title: ')]),
      emails: confirmed.map(f => f.fact.startsWith('Email: ') ? text(f.fact.slice(7)) : null).filter((v): v is string => !!v && EMAIL_RE.test(v)),
      phones: confirmed.map(f => f.fact.startsWith('Phone: ') ? text(f.fact.slice(7)) : null).filter((v): v is string => !!v && PHONE_RE.test(v)),
    };
  };

  for (const card of cards) {
    const people = personOf.get(card.pageId) ?? [];
    if (people.length !== 1) continue;
    const person = people[0]!;
    const got = await personFields(person);
    const safe = safePersonFields({ company: got.company, jobTitle: got.jobTitle, groups: [] }, card.emails, card.phones, countryCode);
    for (const [field, value, now] of [['organization', safe.company, card.company], ['job_title', safe.jobTitle, card.role]] as const) {
      if (value && !now) fills.push({ change: { key: 'enr-' + sha(['fill', card.id, field, value], 40), op: 'fill', id: card.id, field, value: value.slice(0, 300) }, from: person.ref });
    }
    for (const e of got.emails) addValue(card.id, 'emails', e, person.ref);
    for (const p of got.phones) addValue(card.id, 'phones', p, person.ref);
  }

  const google = await engine.executeRaw<{ source_id: string; slug: string; title: string | null; frontmatter: unknown }>(
    `SELECT p.source_id, p.slug, p.title, p.frontmatter FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE s.config->>'kind' = 'google' AND s.archived IS NOT TRUE AND p.deleted_at IS NULL AND p.frontmatter ? 'google_contact_id' ORDER BY p.source_id, p.slug`);
  for (const g of google) {
    const fm = json(g.frontmatter);
    const emails = list(fm.emails), phones = list(fm.phones);
    const ref = { source_id: g.source_id, slug: g.slug };
    const owners = new Set(keysOf(emails, phones).flatMap(k => [...holders.get(k) ?? []]));
    if (owners.size === 1) {
      const [card] = owners;
      if ((personOf.get(cards.find(c => c.id === card)!.pageId) ?? []).length > 1) continue;
      for (const e of emails) addValue(card!, 'emails', e, ref);
      for (const p of phones) addValue(card!, 'phones', p, ref);
      continue;
    }
    if (!createCards || owners.size > 1 || creates.length >= ENRICH_MAX_CREATES) continue;
    const keys = keysOf(emails, phones);
    const name = text(g.title);
    if (!keys.length || keys.some(k => added.has(k)) || !name || name.includes('@') || /^[+\d\s().-]+$/.test(name)) continue;
    const { pages, truncated } = await exactPersonMatches(engine, sourceId, emails, phones, countryCode);
    if (truncated || pages.length !== 1) continue;
    const [person] = await engine.executeRaw<{ frontmatter: unknown }>('SELECT frontmatter FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [pages[0]!.source_id, pages[0]!.slug]);
    const got = await personFields({ ref: pages[0]!, fm: json(person?.frontmatter) });
    const safe = safePersonFields({ company: got.company, jobTitle: got.jobTitle, groups: [] }, emails, phones, countryCode);
    const parts = name.split(/\s+/);
    const fields: Record<string, unknown> = {
      given_name: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0], ...(parts.length > 1 ? { family_name: parts[parts.length - 1] } : {}),
      ...(safe.company ? { organization: safe.company.slice(0, 300) } : {}), ...(safe.jobTitle ? { job_title: safe.jobTitle.slice(0, 300) } : {}),
      ...(emails.length ? { emails: emails.map(value => ({ label: '', value })) } : {}), ...(phones.length ? { phones: phones.map(value => ({ label: '', value })) } : {}),
    };
    for (const k of keys) added.add(k);
    creates.push({ change: { key: 'enr-' + sha(['create', ...keys.sort()], 40), op: 'create', fields }, from: ref });
  }
  return [...fills, ...adds, ...creates].slice(0, ENRICH_MAX_CHANGES);
}

export async function readEnrichRecord(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<EnrichRecord | null> {
  const [row] = await engine.executeRaw<{ v: unknown }>('SELECT completed_keys AS v FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_ENRICH_OP, sourceId]);
  const value = typeof row?.v === 'string' ? JSON.parse(row.v) as unknown : row?.v;
  const record = Array.isArray(value) ? json(value[0]) : {};
  return typeof record.at === 'string' ? record as unknown as EnrichRecord : null;
}

async function writeEnrichRecord(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, record: EnrichRecord): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [APPLE_CONTACTS_ENRICH_OP, sourceId, JSON.stringify([record])]);
}

export interface EnrichDeps { send?: typeof sendContactsBatch; now?: () => number }

/** One enrichment run after a clean pull: nothing when `apple_contacts.enrich` is off; the record of what it did otherwise. */
export async function runAppleContactsEnrichment(engine: BrainEngine, sourceId: string, cfg: Pick<AppleContactsSourceConfig, 'helperHost' | 'helperPort' | 'proxy'>,
  countryCode: string, deps: EnrichDeps = {}): Promise<EnrichRecord | null> {
  const norm = (value: string | null) => String(value ?? '').trim().toLowerCase();
  const mode = norm(await engine.getConfig(ENRICH_CONFIG_KEY).catch(() => null));
  if (mode !== 'on' && mode !== 'dry_run') return null;
  const proposals = await proposeEnrichment(engine, sourceId, countryCode);
  const batch = proposals.length ? 'enr-' + sha(proposals.map(p => p.change.key), 24) : null;
  const row = (p: EnrichProposal, status: string, reason: string | null) => ({
    key: p.change.key, op: p.change.op, card: p.change.id ?? null, field: p.change.field ?? null,
    value: p.change.op === 'fill' ? p.change.value ?? null : null, from: p.from.source_id + ':' + p.from.slug, status, reason,
  });
  const record: EnrichRecord = { at: new Date((deps.now ?? Date.now)()).toISOString(), mode, sent: false, note: null, batch, changes: proposals.map(p => row(p, 'proposed', null)) };
  if (mode === 'on' && proposals.length) {
    const write = norm(await engine.getConfig(WRITE_CONFIG_KEY).catch(() => null));
    if (write !== 'on') record.note = WRITE_CONFIG_KEY + ' is ' + (write || 'off') + ', so nothing was sent';
    else {
      try {
        const token = readWriteToken(String(await engine.getConfig(WRITE_TOKEN_FILE_CONFIG_KEY).catch(() => null) ?? '').trim());
        const reply: ContactsWriteReply = await (deps.send ?? sendContactsBatch)({ sourceId, cfg, auth: { kind: 'enrich', token }, batch: batch!, countryCode,
          changes: proposals.map(p => p.change) });
        const result = new Map(reply.results.map(r => [r.key, r]));
        record.sent = true;
        record.note = reply.stopped;
        record.changes = proposals.map(p => row(p, result.get(p.change.key)?.status ?? 'not_reached', result.get(p.change.key)?.reason ?? null));
      } catch (error) {
        record.note = (error as { code?: string }).code ?? 'apple_contacts_helper_error';
      }
    }
  }
  await writeEnrichRecord(engine, sourceId, record);
  return record;
}
