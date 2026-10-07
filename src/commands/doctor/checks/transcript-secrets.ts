/**
 * transcript_secret_exposure: conversation pages imported before the
 * transcript lane's `labeled_credential` detector may still carry a typed
 * password (`password: …`, `login user / pass`); nothing rewrites them on
 * upgrade. The check never scans pages itself: it counts imported
 * conversation pages (one indexed aggregate) and reads the summary the
 * read-only `gbrain transcripts audit-secrets` caches, reporting its age.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix } from '../check-fix.ts';
import {
  TRANSCRIPT_PAGE_PREDICATE,
  TRANSCRIPT_SECRET_AUDIT_VERSION,
  loadTranscriptSecretAudit,
} from '../../../core/transcripts/secret-audit.ts';

const NAME = 'transcript_secret_exposure';
const DOCS = 'docs/guides/data-ingestion.md#credential-redaction';
const AUDIT_ARGV = ['gbrain', 'transcripts', 'audit-secrets', '--json'];

function ageText(scannedAt: string, now: number): string {
  const hours = Math.max(0, Math.round((now - Date.parse(scannedAt)) / 3_600_000));
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export async function transcriptSecretExposureCheck(ctx: DoctorContext, now = Date.now()): Promise<Check | null> {
  const engine = connectedEngine(ctx);
  try {
    const [row] = await engine.executeRaw<{ n: number | string }>(`SELECT count(*) AS n FROM pages WHERE ${TRANSCRIPT_PAGE_PREDICATE}`);
    const pages = Number(row?.n ?? 0);
    if (pages === 0) return null;
    const audit = await loadTranscriptSecretAudit(engine);
    if (audit === null || audit.detector_version < TRANSCRIPT_SECRET_AUDIT_VERSION || audit.source_id !== null) {
      const why = audit === null
        ? 'it has never been audited'
        : audit.source_id !== null ? `the last audit covered only source ${audit.source_id}` : 'the last audit used older detectors';
      return {
        name: 'transcript_secret_exposure', status: 'warn', details: { transcript_pages: pages, audited: audit !== null, docs: DOCS },
        message: `${pages} imported conversation page(s) may carry a typed credential from before the labeled-credential detector, and ${why}. ` +
          'Pages are not rewritten automatically. Run the read-only audit to list affected slugs (never values).',
        fix: agentFix(AUDIT_ARGV, 'Lists conversation pages that still carry a credential with hit counts per pattern; changes no page.', NAME, { docs: DOCS }),
      };
    }
    const details = { transcript_pages: pages, ...audit, docs: DOCS };
    const age = ageText(audit.scanned_at, now);
    if (audit.hits_total > 0) {
      return {
        name: 'transcript_secret_exposure', status: 'warn', details,
        message: `The transcript secret audit (${age}) found ${audit.hits_total} credential hit(s) on ${audit.pages_affected} conversation page(s). ` +
          'List them with the audit, then review (`gbrain get <slug>`), edit (`gbrain put <slug>`) or, after asking the user, remove (`gbrain delete <slug>`, purged, as `gbrain transcripts audit-secrets --help` shows) each one, and ask the user to rotate any real credential. Re-run the audit afterwards.',
        fix: agentFix(AUDIT_ARGV, 'Lists the affected slugs and line numbers (never values) so each page can be reviewed; read-only.', NAME, { docs: DOCS }),
      };
    }
    return {
      name: 'transcript_secret_exposure', status: 'ok', details,
      message: `The transcript secret audit (${age}) found no credential in ${audit.pages_scanned} conversation page(s).`,
    };
  } catch (err) {
    return {
      name: 'transcript_secret_exposure', status: 'warn', fix_unavailable_reason: 'check_errored',
      message: `Transcript secret exposure could not be checked: ${err instanceof Error ? err.message : String(err)}. Health is unknown.`,
    };
  }
}

async function runTranscriptSecretExposure(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('transcript_secret_exposure');
  const check = await transcriptSecretExposureCheck(ctx);
  if (check) checks.push(check);
  return checks;
}

export const transcriptSecretExposureEntry: DoctorEntry = {
  name: 'transcript_secret_exposure',
  emits: ['transcript_secret_exposure'],
  run: runTranscriptSecretExposure,
};
