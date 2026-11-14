/**
 * guest_source doctor check (GBRA-504 slice 4, read-only).
 *
 * For every guest source (a guest_sources row, or a source whose config says guest: true):
 *  - fail: the two guest records disagree (config guest: true with no guest_sources row, or a guest_sources row whose
 *    config lacks guest: true; either alone still marks reads, and gbrain guests init restores both), the config lacks
 *    federated or the external_untrusted trust_ceiling, it has a local path, a writer names a removed or unknown
 *    credential, or a writer's grant reaches beyond the guest source;
 *  - warn: the writer list is empty or names a principal that is not a remote credential, no brain owner is set, a
 *    credential bound to the owner cannot read the source (with the exact grant command, and
 *    gbrain guests grant-owner-clients for all of them), or its min_trust floor hides guest notes (F9).
 * Never changes a grant. Database only, so a repo-less brain gets the same check; not applicable without a guest source.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { authSourcesFromGrant, grantFromClient, grantFromRow, grantFromTokenRow } from '../../../core/grants/model.ts';
import { guestSourceSql } from '../../../core/guests/marker.ts';
import { GUEST_TRUST_CEILING } from '../../../core/guests/sources.ts';
import { ownerCredentials } from '../../../core/guests/owner-credentials.ts';

const name = 'guest_source';
type Finding = { level: 'fail' | 'warn'; text: string; fix?: string[] };
type GuestSourceRow = { id: string; local_path: string | null; config: unknown; writers: string[] | null; ceiling: string | null };
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? {}) as Record<string, unknown>;

/** A writer principal's verdict: live, and granted exactly the guest source. */
async function writerFindings(engine: BrainEngine, source: string, writer: string): Promise<Finding[]> {
  const at = writer.indexOf(':');
  const kind = writer.slice(0, at), id = writer.slice(at + 1);
  if (kind !== 'oauth_client' && kind !== 'legacy_token') return [{ level: 'warn', text: 'writer ' + writer + ' is not a remote credential (only an OAuth client or token can be a broker)' }];
  const [row] = kind === 'oauth_client'
    ? await engine.executeRaw<{ row: unknown; live: boolean }>("SELECT to_jsonb(c) - 'client_secret_hash' AS row, (to_jsonb(c)->>'deleted_at') IS NULL AS live FROM oauth_clients c WHERE c.client_id = $1", [id])
    : await engine.executeRaw<{ row: unknown; live: boolean }>('SELECT to_jsonb(t) AS row, t.revoked_at IS NULL AS live FROM access_tokens t WHERE t.id::text = $1', [id]);
  const drop = ['gbrain', 'sources', 'writers', source, '--remove', writer];
  if (!row || !row.live) return [{ level: 'fail', text: 'writer ' + writer + (row ? ' was removed or revoked' : ' names no credential'), fix: drop }];
  const grant = kind === 'oauth_client' ? grantFromClient(grantFromRow(json(row.row))) : grantFromTokenRow(json(row.row));
  const auth = authSourcesFromGrant(grant);
  const reads = auth.allowedSources ?? [auth.sourceId];
  if (auth.sourceId === source && reads.every(s => s === source)) return [];
  return [{ level: 'fail', text: 'writer ' + writer + ' is granted ' + [...new Set([auth.sourceId, ...reads])].join(', ') + ', not exactly ' + source }];
}

async function sourceFindings(engine: BrainEngine, s: GuestSourceRow): Promise<Finding[]> {
  const out: Finding[] = [];
  const init = ['gbrain', 'guests', 'init', '--source', s.id, '--yes'];
  const config = json(s.config);
  const repair = '; its notes still read as guest notes, repair: ' + init.join(' ');
  if (s.writers === null) return [{ level: 'fail', text: 'source ' + s.id + ' says guest: true in its config but has no guest_sources row, so the two guest records disagree and nothing enforces its writer list or ceiling' + repair, fix: init }];
  if (config.guest !== true) out.push({ level: 'fail', text: 'source ' + s.id + ' has a guest_sources row but its config does not say guest: true, so the two guest records disagree' + repair, fix: init });
  const flags = [config.federated === true ? null : 'federated',
    config.trust_ceiling === GUEST_TRUST_CEILING && s.ceiling === GUEST_TRUST_CEILING ? null : 'trust_ceiling ' + GUEST_TRUST_CEILING].filter(Boolean);
  if (flags.length) out.push({ level: 'fail', text: 'source ' + s.id + ' is missing ' + flags.join(', '), fix: init });
  if (s.local_path) out.push({ level: 'fail', text: 'source ' + s.id + ' has a local path; a guest source is database-only' });
  if (!s.writers.length) out.push({ level: 'warn', text: 'source ' + s.id + ' has no writers, so nobody can save guest notes there' });
  for (const w of s.writers) out.push(...await writerFindings(engine, s.id, w));
  const { owner, credentials } = await ownerCredentials(engine, s.id);
  if (!owner) out.push({ level: 'warn', text: 'no brain owner is set (gbrain access owner set <member>), so no guest note can name its readers' });
  const missing = credentials.filter(c => !c.readsGuest);
  for (const c of missing) {
    out.push({ level: 'warn', text: c.kind + ' ' + c.name + ' (' + c.id + ') is bound to the owner but cannot read ' + s.id
      + (c.command ? '; grant it with: ' + c.command : '; it has no source grant gbrain adds to'), fix: ['gbrain', 'guests', 'grant-owner-clients', '--source', s.id] });
  }
  if (missing.length) out.push({ level: 'warn', text: 'or grant every owner credential at once: gbrain guests grant-owner-clients --source ' + s.id + ' --yes' });
  for (const c of credentials.filter(c => c.floorHidesGuests)) {
    out.push({ level: 'warn', text: c.kind + ' ' + c.name + ' (' + c.id + ') has min_trust ' + c.minTrust + ', which hides every guest note (stored at external_untrusted); '
      + 'to show them, lower it with: gbrain auth set-min-trust ' + c.id + ' external_untrusted' });
  }
  return out;
}

export async function guestSourceCheck(engine: BrainEngine): Promise<Check> {
  try {
    const sources = await engine.executeRaw<GuestSourceRow>(
      'SELECT s.id, s.local_path, s.config, g.writers, g.trust_ceiling AS ceiling FROM sources s LEFT JOIN guest_sources g ON g.source_id = s.id '
        + 'WHERE ' + guestSourceSql('s.config', 's.id') + ' ORDER BY s.id');
    if (!sources.length) return infoCheck(name, 'Not applicable: this brain has no guest source (gbrain guests init).', 'not_applicable');
    const findings: Finding[] = [];
    for (const s of sources) findings.push(...await sourceFindings(engine, s));
    const ids = sources.map(s => s.id).join(', ');
    const details = { sources: sources.map(s => ({ source: s.id, writers: s.writers ?? [] })), findings: findings.map(f => ({ level: f.level, text: f.text })) };
    if (!findings.length) return { name, status: 'ok', message: 'Guest source(s) ' + ids + ': flags, ceiling and writers in place, and every owner credential reads them.', details };
    const worst = findings.some(f => f.level === 'fail') ? 'fail' : 'warn';
    const first = findings.find(f => f.level === worst && f.fix) ?? findings.find(f => f.fix);
    const preview = first?.fix?.[2] === 'grant-owner-clients';
    return { name, status: worst, details, message: 'Guest source(s) ' + ids + ': ' + findings.map(f => f.text).join('. ') + '.',
      ...(first?.fix ? { fix: agentFix(first.fix, preview
        ? "Read-only preview of the owner credentials that cannot read the guest source; adding it with --yes is the owner's decision."
        : 'Changes how the guest source is set up or who may write it; ask the brain owner first.', name, preview ? {} : { ask_user: true }) } : {}) };
  } catch (error) {
    return checkError(name, 'check the guest sources', error);
  }
}

async function runGuestSource(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const { name: _name, ...verdict } = await guestSourceCheck(connectedEngine(ctx));
  checks.push({ name: 'guest_source', ...verdict });
  return checks;
}

export const guestSourceEntry: DoctorEntry = {
  name: 'guest_source',
  emits: ['guest_source'],
  run: runGuestSource,
};
