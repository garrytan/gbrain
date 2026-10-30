/**
 * trust_release_unpreviewed_fields (#7656): facts an index-existing `gbrain trust release` raised to user_confirmed
 * before the release preview showed and bound the fence cell's fields. Such a release indexed the live cell (kind,
 * confidence, notability, validity, typed claim, attribution, source, context) while the owner previewed only the
 * text. A row is listed while it is still current, user_confirmed, has origin `trust_release`, is indexed from the
 * fence row its released hold named, and its origin lacks `fields_previewed`. Read-only: it never lowers a tier;
 * the owner reviews each row and edits or forgets what is wrong.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { isMissingSchemaObject } from '../../../core/utils.ts';

const LIMIT = 50;

async function runTrustReleaseUnpreviewed(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const rows = await connectedEngine(ctx).executeRaw<{ id: number; source_id: string; slug: string; row_num: number; hold_id: number; total: number }>(
      `SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.row_num, h.id AS hold_id, COUNT(*) OVER () AS total
         FROM facts f JOIN LATERAL (SELECT id FROM write_gate_holds WHERE kind = 'fact' AND status = 'released' AND source_id = f.source_id
          AND slug = f.source_markdown_slug AND payload->>'row_num' = f.row_num::text ORDER BY id DESC LIMIT 1) h ON true
        WHERE f.trust_tier = 'user_confirmed' AND f.expired_at IS NULL AND f.write_origin->>'channel' = 'trust_release'
          AND f.write_origin->>'fields_previewed' IS NULL
        ORDER BY f.id LIMIT ${LIMIT}`);
    const items = rows.map(r => ({ fact_ref: `f${r.id}`, source_id: r.source_id, slug: r.slug, row_num: Number(r.row_num), hold_ref: `h${r.hold_id}` }));
    const total = rows.length ? Number(rows[0]!.total) : 0;
    const details = { total, items };
    if (!total) {
      checks.push({ name: 'trust_release_unpreviewed_fields', status: 'ok', details,
        message: 'No released fact was confirmed with fence-row fields its release preview did not show.' });
      return checks;
    }
    const first = items[0]!;
    checks.push({ name: 'trust_release_unpreviewed_fields', status: 'warn', details,
      message: `${total} released fact(s) were raised to "confirmed by you" with fence-row fields the release preview did not show (#7656): `
        + `${items.slice(0, 5).map(i => `${i.fact_ref} (${i.source_id}/${i.slug} row ${i.row_num}, released ${i.hold_ref})`).join('; ')}${total > 5 ? `; and ${total - 5} more` : ''}. `
        + 'Ask the user to review each row (gbrain trust explain <fact ref>, then the page\'s facts row) and edit the row or forget the fact if a field is wrong. Nothing was changed; this check never lowers a tier.',
      fix: agentFix(['gbrain', 'trust', 'explain', first.fact_ref], `Shows ${first.fact_ref}'s tier, origin and receipts, read-only; repeat per item in details.items.`, 'trust_release_unpreviewed_fields') });
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', 'write_gate_holds') || isMissingSchemaObject(error, 'column', ['trust_tier', 'write_origin'])) {
      checks.push({ name: 'trust_release_unpreviewed_fields', status: 'ok', details: { schema: 'pre_trust' }, message: 'This schema predates trust releases.' });
    } else {
      checks.push(checkError('trust_release_unpreviewed_fields', 'list released facts with unpreviewed fence-row fields', error));
    }
  }
  return checks;
}

export const trustReleaseUnpreviewedEntry: DoctorEntry = { name: 'trust_release_unpreviewed_fields', emits: ['trust_release_unpreviewed_fields'], run: runTrustReleaseUnpreviewed };
