/**
 * Plan GST-3256, decision B: a contact whose identity link reaches exactly one people/ page gives that person page three
 * kinds of facts and nothing else: company (organization), job title and each Contacts group name, one row each in the
 * page's ## Facts fence. Phones, emails, the nickname and the contact id never leave the owner-only contact page, and
 * a value that carries one of the contact's emails or phone numbers is dropped.
 *
 * Rows are written through remember (persistence/memory-mutations.ts), with the source's provenance
 * (apple-contacts:<source id>) in the row's source column; a changed company or job title replaces the row it had
 * (remember's replaces). A row this source no longer wants is retired with retire_connector_facts
 * (persistence/connector-fact-retirement.ts): only rows carrying this source's provenance, never a withdrawal, so the
 * same claim comes back when the contact does. A claim already active on the page (the owner's own, say) is not
 * written again and is never retired. Both writes are fence edits: the page's text outside the fence, its frontmatter
 * and its trust tier stay as they were; on a source with a Git checkout the file is written first, as for any remember.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { OperationContext } from '../ops/contract.ts';
import { canonicalPhone } from '../phone-key.ts';
import { retireConnectorFacts } from '../persistence/connector-fact-retirement.ts';

/** op_checkpoints row (fingerprint = source id): each person page carrying this source's facts, and the contact behind it. */
export const APPLE_CONTACTS_PERSON_FACTS_OP = 'apple-contacts-person-facts';

export const personFactSource = (sourceId: string) => 'apple-contacts:' + sourceId;

export interface PersonFields { company: string | null; jobTitle: string | null; groups: string[] }

/**
 * The fields with any value that carries one of the contact's emails or phone numbers left out, so a company or a
 * group named after an address or a number can never copy it onto a people/ page.
 */
export function safePersonFields(fields: PersonFields, emails: string[], phones: string[], countryCode: string): PersonFields {
  const addresses = emails.map(e => e.trim().toLowerCase()).filter(Boolean);
  const numbers = phones.flatMap(p => { const k = canonicalPhone(p, countryCode); const raw = p.replace(/\D/g, ''); return [k?.slice(1), k?.slice(1 + countryCode.length), raw]; })
    .filter((d): d is string => !!d && d.length >= 7);
  const safe = (value: string | null) => {
    if (!value) return null;
    const lower = value.toLowerCase();
    const digits = value.replace(/\D/g, '');
    return /[^\s@]+@[^\s@]+/.test(value) || addresses.some(a => lower.includes(a)) || numbers.some(n => digits.includes(n)) ? null : value;
  };
  return { company: safe(fields.company), jobTitle: safe(fields.jobTitle), groups: fields.groups.map(safe).filter((g): g is string => !!g) };
}

/** The claims a person page should carry from these fields, one per company, job title and group. */
export function personClaims(fields: PersonFields): string[] {
  const clean = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const claims = [
    clean(fields.company) ? 'Company: ' + clean(fields.company) : null,
    clean(fields.jobTitle) ? 'Job title: ' + clean(fields.jobTitle) : null,
    ...fields.groups.map(g => clean(g) ? 'Contacts group: ' + clean(g) : null),
  ].filter((c): c is string => c !== null);
  return [...new Set(claims)];
}

const slotOf = (claim: string) => claim.startsWith('Company: ') ? 'company' : claim.startsWith('Job title: ') ? 'job_title' : null;

export type PersonFactsWrite = 'written' | 'unchanged' | 'skipped';

/**
 * Bring this source's rows on one person page to claims (empty retires them all). A missing page writes nothing
 * ('skipped'); a claim the owner withdrew is left withdrawn.
 */
export async function syncPersonFacts(engine: BrainEngine, contactsSourceId: string, person: { source_id: string; slug: string }, claims: string[],
  log: (line: string) => void): Promise<PersonFactsWrite> {
  const tag = personFactSource(contactsSourceId);
  const claimFps = claims.length ? await engine.executeRaw<{ fp: string }>(
    'SELECT gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n', [claims]) : [];
  const fpOf = new Map(claims.map((c, i) => [c, claimFps[i]!.fp]));
  const active = await engine.executeRaw<{ id: number; fact: string; source: string | null; fp: string }>(
    'SELECT id,fact,source,gbrain_fact_fingerprint(fact) AS fp FROM facts WHERE source_id=$1 AND (source_markdown_slug=$2 OR entity_slug=$2 OR (entity_slug IS NULL AND gbrain_fact_fingerprint(fact) = ANY($3::text[]))) AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) ORDER BY id',
    [person.source_id, person.slug, [...fpOf.values()]]);
  const ours = active.filter(r => r.source === tag).map(r => ({ id: Number(r.id), fact: r.fact.trim(), fp: r.fp }));
  // An owner's copy of a claim (any case or spacing, the way remember matches) counts as known: writing it linked would supersede that copy.
  const known = new Set(active.filter(r => r.source !== tag).map(r => r.fp));
  const wanted = new Set(fpOf.values());
  const kept = new Set<string>();
  const retire: Array<{ id: number; fact: string }> = [];
  for (const row of ours) {
    if (wanted.has(row.fp) && !kept.has(row.fp)) kept.add(row.fp); else retire.push(row);
  }
  const add = claims.filter(c => !kept.has(fpOf.get(c)!) && !known.has(fpOf.get(c)!));
  if (!add.length && !retire.length) return 'unchanged';
  if (add.length) {
    const snapshot = await engine.readPageSnapshot(person.slug, { sourceId: person.source_id });
    if (!snapshot || snapshot.page.deleted_at) return 'skipped';
    const { operationsByName } = await import('../operations.ts');
    const ctx = { engine, config: { engine: engine.kind } as unknown as GBrainConfig, remote: false, dryRun: false, sourceId: person.source_id,
      logger: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as OperationContext;
    for (const claim of add) {
      const slot = slotOf(claim);
      const old = slot ? retire.find(r => slotOf(r.fact) === slot) : undefined;
      try {
        await operationsByName.remember!.handler(ctx, { fact: claim, entity: person.slug, source_id: person.source_id, provenance: tag, infer_entity: false,
          ...(old ? { replaces: old.id } : {}) });
      } catch (error) {
        const e = error as { reason?: string; message?: string };
        if (e.reason !== 'fact_withdrawn' && !/fact_withdrawn/.test(e.message ?? '')) throw error;
        log('[apple-contacts] ' + contactsSourceId + ': ' + person.slug + ' had "' + claim + '" withdrawn by its owner; left withdrawn');
        continue;
      }
      if (old) retire.splice(retire.indexOf(old), 1);
    }
  }
  if (retire.length) await retireConnectorFacts(engine, person.source_id, person.slug, { factSource: tag, factIds: retire.map(r => r.id), note: 'removed in Apple Contacts' });
  return 'written';
}

/** Active rows this apple-contacts source wrote on person pages, and how many of them no page write can retire. */
async function personFactCounts(engine: Pick<BrainEngine, 'executeRaw'>, contactsSourceId: string): Promise<{ active: number; stuck: number }> {
  const [row] = await engine.executeRaw<{ active: number; stuck: number }>(
    'SELECT count(*)::int AS active, (count(*) FILTER (WHERE f.source_markdown_slug IS NULL OR s.id IS NULL OR s.archived))::int AS stuck FROM facts f LEFT JOIN sources s ON s.id=f.source_id WHERE f.source=$1 AND f.expired_at IS NULL',
    [personFactSource(contactsSourceId)]);
  return { active: Number(row?.active ?? 0), stuck: Number(row?.stuck ?? 0) };
}

export const countPersonFacts = async (engine: Pick<BrainEngine, 'executeRaw'>, contactsSourceId: string) => (await personFactCounts(engine, contactsSourceId)).active;

/**
 * Before an apple-contacts source is removed or purged: retire every person-page row it wrote. Those rows live in the
 * people pages' own sources, so deleting the source alone would leave them behind. Clears the source's holder list.
 * Throws before retiring anything when a row has no page slug or its page's source is archived or gone, and throws when
 * a row is still active afterwards, so the caller stops before the source is deleted.
 */
export async function retireAllPersonFacts(engine: BrainEngine, contactsSourceId: string): Promise<number> {
  const tag = personFactSource(contactsSourceId);
  const { stuck } = await personFactCounts(engine, contactsSourceId);
  if (stuck > 0) {
    throw new Error('Source "' + contactsSourceId + '" has ' + stuck + ' active fact row(s) on person pages that cannot be retired (no page slug, or the page\'s source is archived or gone), so nothing was retired and the source was not removed. Restore an archived people source first; otherwise report it with the output of gbrain doctor --json.');
  }
  const pages = await engine.executeRaw<{ source_id: string; slug: string; ids: number[] }>(
    'SELECT source_id, source_markdown_slug AS slug, array_agg(id ORDER BY id) AS ids FROM facts WHERE source=$1 AND expired_at IS NULL AND source_markdown_slug IS NOT NULL GROUP BY source_id, source_markdown_slug ORDER BY source_id, source_markdown_slug',
    [tag]);
  let retired = 0;
  for (const page of pages) {
    const ids = page.ids.map(Number);
    await retireConnectorFacts(engine, page.source_id, page.slug, { factSource: tag, factIds: ids, note: 'Apple Contacts source removed' });
    retired += ids.length;
  }
  const left = await countPersonFacts(engine, contactsSourceId);
  if (left > 0) {
    throw new Error('Source "' + contactsSourceId + '" still has ' + left + ' active fact row(s) on person pages that changed during the remove and could not be retired, so it was not removed. Run the remove again.');
  }
  await writePersonFactHolders(engine, contactsSourceId, {});
  return retired;
}

/** The step every source removal runs before the row delete: an apple-contacts source retires its person-page rows first. */
export async function retirePersonFactsBeforeRemove(engine: BrainEngine, sourceId: string): Promise<void> {
  const src = await engine.readSourceIncarnation(sourceId);
  const kind = (src?.config as { kind?: unknown } | null | undefined)?.kind;
  if (kind === 'apple-contacts') await retireAllPersonFacts(engine, sourceId);
}

export type PersonFactHolders = Record<string, string>;
export const holderKey = (p: { source_id: string; slug: string }) => p.source_id + '\t' + p.slug;

export async function readPersonFactHolders(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<PersonFactHolders> {
  const [row] = await engine.executeRaw<{ v: unknown }>('SELECT completed_keys AS v FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_PERSON_FACTS_OP, sourceId]);
  let value = row?.v;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  const first = Array.isArray(value) ? value[0] : null;
  return first && typeof first === 'object' ? first as PersonFactHolders : {};
}

export async function writePersonFactHolders(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, holders: PersonFactHolders): Promise<void> {
  if (!Object.keys(holders).length) {
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_PERSON_FACTS_OP, sourceId]);
    return;
  }
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [APPLE_CONTACTS_PERSON_FACTS_OP, sourceId, JSON.stringify([holders])]);
}
