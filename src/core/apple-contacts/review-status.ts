/**
 * How gbrain sync status shows an apple-contacts identity review (apple-contacts/identity-match.ts): one contact page
 * whose email or phone matches two or more person pages. It is never linked by guess; the owner decides with
 * gbrain dedupe confirm (the candidates are one person: the next sync links the contact) or gbrain dedupe reject (they
 * are different people: the review stays, decided, and the contact stays unlinked). Dependency-light: sync status
 * reads it on every call.
 *
 * It also shows the deletions an incremental run held at the delete floor (apple-contacts-source.ts): the contacts
 * the helper reported deleted, kept pending in op_checkpoints until a later run applies or cancels them.
 */
import type { Action } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';

export const APPLE_CONTACTS_REVIEW_OP = 'apple-contacts-identity-review';

export interface IdentityReviewStatus {
  contact_slug: string;
  candidates: Array<{ source_id: string; slug: string }>;
  decided: 'different' | null;
  needs_human: boolean;
  human_reason: string;
  fix: Action;
}

export function identityReviewStatus(sourceId: string, raw: unknown): IdentityReviewStatus[] {
  let value = raw;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const r = entry as { slug?: unknown; candidates?: unknown; decided?: unknown } | null;
    if (!r || typeof r.slug !== 'string' || !Array.isArray(r.candidates)) return [];
    const candidates = (r.candidates as Array<{ source_id?: unknown; slug?: unknown }>)
      .filter(c => typeof c?.source_id === 'string' && typeof c?.slug === 'string') as Array<{ source_id: string; slug: string }>;
    const decided = r.decided === 'different' ? 'different' as const : null;
    const names = candidates.map(c => `${c.slug} (${c.source_id})`).join(', ');
    return [{ contact_slug: r.slug, candidates, decided, needs_human: decided === null,
      human_reason: decided ? `Contact ${r.slug} matches ${names}, which the owner recorded as different people; it stays unlinked.`
        : `Contact ${r.slug} has an email or phone that matches ${candidates.length} person pages (${names}); it is not linked to any of them until the owner says whether they are one person.`,
      fix: { argv: ['gbrain', 'dedupe', '--preview', '--source', candidates[0]?.source_id ?? sourceId], consent: [], actor: 'user', requires_exclusive: false,
        why: `Lists the duplicate groups with their evidence: gbrain dedupe confirm <group-id> if ${names} are one person (the next sync of ${sourceId} links the contact), gbrain dedupe reject <group-id> if they are not.` } }];
  });
}

/** op_checkpoints row (fingerprint = source id): the pending deletions and, when the floor held them, why. */
export const APPLE_CONTACTS_PENDING_DELETES_OP = 'apple-contacts-pending-deletes';

export interface HeldDeletes { code: 'apple_contacts_delete_floor'; contacts: number; owned: number; since: string }

function decodedRow(raw: unknown): { ids: string[]; held: HeldDeletes | null } {
  let value = raw;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  const row = (Array.isArray(value) ? value[0] : null) as { ids?: unknown; held?: unknown } | null;
  const ids = Array.isArray(row?.ids) ? row!.ids.filter((id): id is string => typeof id === 'string') : [];
  const held = row?.held as HeldDeletes | null | undefined;
  return { ids, held: held && held.code === 'apple_contacts_delete_floor' && typeof held.contacts === 'number' ? held : null };
}

export async function readPendingDeletes(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<{ ids: string[]; held: HeldDeletes | null }> {
  const [row] = await engine.executeRaw<{ v: unknown }>('SELECT completed_keys AS v FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_PENDING_DELETES_OP, sourceId]);
  return decodedRow(row?.v);
}

export async function writePendingDeletes(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, ids: string[], held: HeldDeletes | null): Promise<void> {
  if (!ids.length) {
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [APPLE_CONTACTS_PENDING_DELETES_OP, sourceId]);
    return;
  }
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [APPLE_CONTACTS_PENDING_DELETES_OP, sourceId, JSON.stringify([{ ids, held }])]);
}

export interface HeldDeletesStatus extends HeldDeletes {
  needs_human: true;
  human_reason: string;
  fix: Action;
}

/** The deletions the floor holds for sync status, or null when none are held. */
export function heldDeletesStatus(sourceId: string, raw: unknown): HeldDeletesStatus | null {
  const { held } = decodedRow(raw);
  if (!held) return null;
  return { ...held, needs_human: true,
    human_reason: `The helper reported ${held.contacts} of the ${held.owned} contacts of ${sourceId} as deleted, more than the delete floor lets through, so none was deleted (apple_contacts_delete_floor). Check Contacts on the Mac; if the contacts come back, the next sync cancels the deletions.`,
    fix: { ask_user: true, argv: ['gbrain', 'sync', '--source', sourceId], consent: ['destructive'], actor: 'user', requires_exclusive: false,
      user_message: `Were ${held.contacts} contacts really deleted from Contacts on the Mac? If yes, run GBRAIN_ALLOW_MASS_RECONCILE=1 gbrain sync --source ${sourceId} once (it never deletes every contact). If not, fix Contacts on the Mac; the next sync cancels the deletions.`,
      why: `Applies the held deletions only with GBRAIN_ALLOW_MASS_RECONCILE=1 in the environment; a plain run keeps them pending.` } };
}
