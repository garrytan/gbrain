/**
 * Guest notes, slice 4 (GBRA-504, decision K1, F9, F10): the brain owner's credentials and the guest source.
 *
 * The owner's local CLI and stdio reads already include every federated source, guest sources too. A token or OAuth
 * client bound to the owner (member_id = config access.owner_member) reads only the sources its grant names, so it
 * sees guest notes only once a guest source is on its read list. ownerCredentials lists each such credential with its
 * read list, whether it reads the guest source, the read list it would have with it, the exact grant command, and its
 * min_trust floor (a floor above external_untrusted hides every guest note, F9). grantOwnerCredentials is the one
 * writer: 'gbrain guests grant-owner-clients --yes' adds the guest source to each read list as a compare-and-set on
 * the grant revision the preview read, keeps every source already there, and never runs on its own: gbrain widens no
 * grant on upgrade or init. The doctor check guest_source (commands/doctor/checks/guest-source.ts) reads the same list.
 */
import type { BrainEngine } from '../engine.ts';
import { ownerMemberId } from '../access/owner.ts';
import { GrantError, grantFromClient, grantFromRow, grantFromTokenRow, type PrincipalGrant } from '../grants/model.ts';
import { readClientGrant, rescopeClientGrant } from '../grants/service.ts';
import { rescopeLegacyToken } from '../grants/legacy-token.ts';
import { compareTrust, storedMinTrust, type TrustTier } from '../trust/tier.ts';

export interface OwnerCredential {
  kind: 'client' | 'token';
  id: string;
  name: string;
  revision: number;
  /** none: the explicit no-source grant; default: no source grant (reads the default source only). */
  grant: PrincipalGrant['sources']['kind'];
  writeSource: string | null;
  readSources: string[];
  readsGuest: boolean;
  /** The read list with the guest source added; null when there is nothing gbrain may add to (no-source grant). */
  after: string[] | null;
  /** The exact command that adds the guest source to this one grant, at the revision read. */
  command: string | null;
  minTrust: TrustTier | null;
  /** The floor admits no guest note (above external_untrusted). */
  floorHidesGuests: boolean;
}

function readsOf(g: PrincipalGrant): { write: string | null; reads: string[] } {
  switch (g.sources.kind) {
    case 'none': return { write: null, reads: [] };
    case 'default': return { write: 'default', reads: ['default'] };
    case 'scalar': return { write: g.sources.writeSource, reads: [g.sources.writeSource] };
    case 'federated': return { write: g.sources.writeSource, reads: [...g.sources.readSources] };
  }
}

function credential(kind: 'client' | 'token', id: string, name: string, g: PrincipalGrant, minTrustValue: unknown, guest: string): OwnerCredential {
  const { write, reads } = readsOf(g);
  const readsGuest = reads.includes(guest);
  const tokenListKept = kind === 'client' || g.sources.kind !== 'federated' || reads[0] === write;
  const after = g.sources.kind === 'none' || !tokenListKept ? null : readsGuest ? reads : [...reads, guest];
  const rev = ' --if-version ' + g.revision;
  const command = readsGuest || !after ? null
    : kind === 'token' ? 'gbrain auth rescope-token --id ' + id + ' --sources ' + after.join(',') + rev
    : g.sources.kind === 'default' ? 'gbrain auth rescope --client ' + id + ' --sources ' + after.join(',') + rev
    : 'gbrain auth rescope --client ' + id + ' --read-sources ' + after.join(',') + rev;
  const minTrust = storedMinTrust(minTrustValue) ?? null;
  return { kind, id, name, revision: g.revision, grant: g.sources.kind, writeSource: write, readSources: reads, readsGuest, after, command,
    minTrust, floorHidesGuests: minTrust !== null && compareTrust(minTrust, 'external_untrusted') > 0 };
}

const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

/** Every live credential bound to the brain owner, read against guest source guestSourceId; no owner, no credentials. */
export async function ownerCredentials(engine: BrainEngine, guestSourceId: string): Promise<{ owner: string | null; credentials: OwnerCredential[] }> {
  const owner = await ownerMemberId(engine);
  if (!owner) return { owner, credentials: [] };
  const rows = await engine.executeRaw<{ kind: 'client' | 'token'; id: string; name: string; row: unknown }>(
    "SELECT 'token' AS kind, t.id::text AS id, t.name, to_jsonb(t) AS row FROM access_tokens t WHERE t.member_id = $1 AND t.revoked_at IS NULL "
      + "UNION ALL SELECT 'client' AS kind, c.client_id AS id, COALESCE(c.client_name, c.client_id) AS name, to_jsonb(c) - 'client_secret_hash' AS row "
      + "FROM oauth_clients c WHERE c.member_id = $1 AND (to_jsonb(c)->>'deleted_at') IS NULL ORDER BY 1, 3, 2", [owner]);
  return { owner, credentials: rows.map(r => {
    const row = json(r.row);
    const grant = r.kind === 'token' ? grantFromTokenRow(row) : grantFromClient(grantFromRow(row));
    return credential(r.kind, r.id, r.name, grant, row.min_trust, guestSourceId);
  }) };
}

export interface GrantOutcome { kind: 'client' | 'token'; id: string; name: string; outcome: 'granted' | 'conflict' | 'skipped'; detail?: string }

/**
 * Adds guestSourceId to the read list of each previewed credential that lacks it, at the revision the preview read.
 * A grant changed since (another edit, a rescope) is a conflict and stays as it is; each result is read back and must
 * equal the previewed list plus the guest source.
 */
export async function grantOwnerCredentials(engine: BrainEngine, guestSourceId: string, plan: readonly OwnerCredential[]): Promise<GrantOutcome[]> {
  const out: GrantOutcome[] = [];
  for (const c of plan) {
    const base = { kind: c.kind, id: c.id, name: c.name };
    if (c.readsGuest) continue;
    if (!c.after) { out.push({ ...base, outcome: 'skipped', detail: c.grant === 'none' ? 'it has no source grant' : 'its write source is not on its read list; change it by hand' }); continue; }
    try {
      if (c.kind === 'client') {
        const patch = c.grant === 'default' ? { sourceId: 'default', federatedRead: c.after } : { federatedRead: c.after };
        await rescopeClientGrant(engine, c.id, patch, { actor: 'operator:guests-grant-owner-clients', expectedRevision: c.revision });
        const now = grantFromClient(await readClientGrant(engine, c.id));
        if (JSON.stringify(readsOf(now).reads) !== JSON.stringify(c.after)) throw new Error('read back ' + readsOf(now).reads.join(', '));
      } else {
        const result = await rescopeLegacyToken(engine, { target: { id: c.id }, sources: c.after, expectedRevision: c.revision,
          reset: [], refreshOperations: false, allNew: false, dryRun: false, json: false });
        if (JSON.stringify(result.after.sources) !== JSON.stringify(c.after)) throw new Error('read back ' + JSON.stringify(result.after.sources));
      }
      out.push({ ...base, outcome: 'granted' });
    } catch (e) {
      if (e instanceof GrantError && e.code === 'grant_conflict') { out.push({ ...base, outcome: 'conflict', detail: e.message }); continue; }
      throw e;
    }
  }
  return out;
}
