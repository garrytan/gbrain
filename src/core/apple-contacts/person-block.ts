/**
 * Plan GST-3256, decision B: a contact whose identity link reaches exactly one people/ page writes a small block onto that
 * person page with three fields and nothing else: company (organization), job title and the Contacts group names.
 * Phones, emails, the nickname and the contact id never leave the owner-only contact page.
 *
 * The block is the managed-block.ts grammar (one exact-line begin/end marker pair, named for the source; text outside
 * the markers is never touched; damaged markers refuse) inside the page's compiled truth, and every write goes through
 * the edit_page door (persistence/page-mutations.ts submitPageMutation), bound to the revision it read, so an unchanged
 * block writes nothing and a changed one rewrites only the block. On a source with a Git checkout the door writes the
 * file first and it is committed as every door write is (the write coordinator, or the write-through commit on a
 * hardened repository); on a repo-less brain the database is the record. The door marks the page agent-written
 * (`trust_tier: agent_written` in its frontmatter), as it does for every automated edit.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { GBrainConfig } from '../config.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { neutralizeOutsideText } from '../outside-content.ts';
import { canonicalPhone } from '../phone-key.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';

/** op_checkpoints row (fingerprint = source id): each person page carrying this source's block, and the contact behind it. */
export const APPLE_CONTACTS_BLOCKS_OP = 'apple-contacts-person-blocks';

export interface PersonBlockFields { company: string | null; jobTitle: string | null; groups: string[] }

export const personBlockMarkers = (sourceId: string): BlockMarkers => ({
  begin: `<!-- gbrain:apple-contacts:${sourceId}:begin -->`,
  end: `<!-- gbrain:apple-contacts:${sourceId}:end -->`,
  label: 'Apple Contacts', rerun: `gbrain sync --source ${sourceId}`,
});

/**
 * The fields with any value that carries one of the contact's emails or phone numbers left out, so a company or a
 * group named after an address or a number can never copy it onto a people/ page.
 */
export function safePersonFields(fields: PersonBlockFields, emails: string[], phones: string[], countryCode: string): PersonBlockFields {
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

/** The block's interior, or null when there is nothing to say (no block). */
export function personBlockInterior(fields: PersonBlockFields): string | null {
  const lines = [
    fields.company ? neutralizeOutsideText(`- Company: ${fields.company}`) : null,
    fields.jobTitle ? neutralizeOutsideText(`- Job title: ${fields.jobTitle}`) : null,
    fields.groups.length ? neutralizeOutsideText(`- Contacts groups: ${fields.groups.join(', ')}`) : null,
  ].filter((l): l is string => !!l);
  return lines.length ? ['From Apple Contacts (kept in sync; edit it in Contacts):', ...lines].join('\n') : null;
}

export type BlockWrite = 'written' | 'unchanged' | 'removed' | 'absent' | 'skipped';

function localContext(engine: BrainEngine, sourceId: string): OperationContext {
  return { engine, config: { engine: engine.kind } as unknown as GBrainConfig, remote: false, dryRun: false, sourceId,
    logger: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as OperationContext;
}

/**
 * Bring this source's block on one person page to `interior` (null removes it). Reads the page, splices or strips the
 * block in its compiled truth, and submits the one exact replacement through edit_page; returns what happened.
 * A missing page, a segmented page or damaged markers write nothing ('skipped').
 */
export async function syncPersonBlock(engine: BrainEngine, contactsSourceId: string, person: { source_id: string; slug: string }, interior: string | null): Promise<BlockWrite> {
  const markers = personBlockMarkers(contactsSourceId);
  const snapshot = await engine.readPageSnapshot(person.slug, { sourceId: person.source_id });
  if (!snapshot || snapshot.page.deleted_at || isSegmentedPage(snapshot.page)) return 'skipped';
  const body = snapshot.page.compiled_truth ?? '';
  const probe = probeBlock(markers, body);
  if (probe.state === 'damaged') return 'skipped';
  if (interior === null && probe.state === 'absent') return 'absent';
  if (interior !== null && probe.state === 'present' && probe.interior === interior) return 'unchanged';
  const next = interior === null ? removeBlock(markers, body).text : spliceBlock(markers, body, interior);
  const { editableView } = await import('../persistence/page-edit.ts');
  const before = editableView(snapshot.page, snapshot.tags, false);
  const after = editableView({ ...snapshot.page, compiled_truth: next }, snapshot.tags, false);
  if (before === after) return 'unchanged';
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // The changed span, widened over whole lines until the old text occurs exactly once in the page.
  let from = before.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let to = before.length - end;
  const once = (s: string) => s.length > 0 && before.indexOf(s) === before.lastIndexOf(s) && before.indexOf(s) >= 0;
  while (!once(before.slice(from, to))) {
    if (from > 0) from = before.lastIndexOf('\n', from - 2) + 1;
    else if (to < before.length) to = Math.min(before.length, (before.indexOf('\n', to + 1) + 1) || before.length);
    else break;
  }
  const oldText = before.slice(from, to);
  const newText = after.slice(from, after.length - (before.length - to));
  const { submitPageMutation } = await import('../persistence/page-mutations.ts');
  await submitPageMutation(localContext(engine, person.source_id), { operation: 'edit_page', params: {
    slug: person.slug, source_id: person.source_id, expected_revision: snapshot.revision, request_id: randomUUID(),
    reason: `apple-contacts(${contactsSourceId}): company, job title and groups from Apple Contacts`,
    edits: [{ old_text: oldText, new_text: newText }] } });
  return interior === null ? 'removed' : 'written';
}


export type PersonBlocks = Record<string, string>;
export const blockKey = (p: { source_id: string; slug: string }) => `${p.source_id}\t${p.slug}`;

export async function readPersonBlocks(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<PersonBlocks> {
  const [row] = await engine.executeRaw<{ v: unknown }>('SELECT completed_keys AS v FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_BLOCKS_OP, sourceId]);
  let value = row?.v;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  const first = Array.isArray(value) ? value[0] : null;
  return first && typeof first === 'object' ? first as PersonBlocks : {};
}

export async function writePersonBlocks(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, blocks: PersonBlocks): Promise<void> {
  if (!Object.keys(blocks).length) {
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_BLOCKS_OP, sourceId]);
    return;
  }
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [APPLE_CONTACTS_BLOCKS_OP, sourceId, JSON.stringify([blocks])]);
}
