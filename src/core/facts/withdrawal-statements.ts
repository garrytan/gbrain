/**
 * The forget commit's claim lock and the `fact_withdrawn` refusal's two reads, as whole statement texts built once at
 * module load. The typed members in engine-sql/trust-withdrawals.ts pass them to `executeRaw` as they are, so Postgres
 * gets the text recordFactWithdrawal (withdrawal.ts) and factWithdrawnRefusal (single-prepare.ts) sent before: the
 * refusal reads reuse a placeholder ($3, $5, $6), which `sqlFragment` would renumber. Every part is a constant
 * builder over code-provided aliases; no value reaches the text.
 *
 * Lock binds: $1 id, $2 source, $3 worldOnly, $4 member page (GST-359 D: an attested person's own member-page fact).
 * Backing binds: $1 source, $2 visibility, $3 claim, $4 entity, $5 owned page.
 * Row binds: $1 source, $2 visibility, $3 claim, $4 entity, $5 excludePrivate, $6 owned page.
 */
import { factWithdrawalSubjectSql, withdrawalReachedFactSql } from '../access/member-facts.ts';
import { remoteProvenanceFloorSql } from '../search/private-visibility.ts';

function lockSql(remoteFloor: boolean): string {
  const admit = `AND ($3::boolean=false OR visibility='world' OR (visibility='private' AND source_markdown_slug=$4::text))${remoteFloor ? ` AND ${remoteProvenanceFloorSql('facts')}` : ''}`;
  return `SELECT visibility,fact,${factWithdrawalSubjectSql('facts')} AS subject FROM facts WHERE id=$1 AND source_id=$2
        ${admit} FOR UPDATE`;
}

export const LOCK_FACT_FOR_WITHDRAWAL_SQL = lockSql(false);
export const LOCK_FACT_FOR_WITHDRAWAL_FLOOR_SQL = lockSql(true);

// GST-359 D: a member writing to its own member page sees that page's withdrawn rows.
const seen = (param: number) => `(${remoteProvenanceFloorSql('f')} OR COALESCE(f.source_markdown_slug = $${param}::text, false))`;

export const FACT_WITHDRAWN_BACKING_SQL = `SELECT
        COALESCE(bool_or(${seen(5)}), false) AS visible,
        COALESCE(bool_or(NOT ${seen(5)}), false) AS hidden
      FROM facts f JOIN fact_withdrawals w ON w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v2(f.fact),gbrain_fact_fingerprint_v1(f.fact))
        AND ${withdrawalReachedFactSql('w', 'f')}
      WHERE f.source_id=$1 AND f.visibility=$2 AND f.expired_at IS NOT NULL
        AND gbrain_fact_fingerprint(f.fact)=gbrain_fact_fingerprint($3) AND (w.subject='*' OR w.subject=$4::text OR w.subject=$5::text)`;

export const FACT_WITHDRAWN_ROW_SQL = `SELECT w.subject,w.visibility,w.withdrawn_at::text AS withdrawn_at
    FROM fact_withdrawals w LEFT JOIN facts f ON f.source_id=w.source_id AND f.visibility=w.visibility AND f.expired_at IS NOT NULL
      AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v2(f.fact),gbrain_fact_fingerprint_v1(f.fact)) AND ${withdrawalReachedFactSql('w', 'f')}
    WHERE w.source_id=$1 AND w.visibility=$2 AND w.fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v2($3),gbrain_fact_fingerprint_v1($3))
      AND (w.subject='*' OR w.subject=$4::text OR w.subject=$6::text)
    GROUP BY w.subject,w.visibility,w.withdrawn_at
    HAVING $5::boolean=false OR COALESCE(bool_or(${seen(6)}), false) OR NOT COALESCE(bool_or(f.id IS NOT NULL), false)
    ORDER BY (w.subject<>'*') DESC, w.withdrawn_at DESC LIMIT 1`;
