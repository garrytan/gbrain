/**
 * secret_store (GST-2988 PR 3): the health of the secret store that keeps the originals redaction replaced.
 *
 * Reports entries and occurrences; where the store is backed up (the last upload to the configured storage backend, or
 * that the database backup carries it); which keys entries need and whether this host holds them (a key in use that is
 * not here usually means another host sharing the database sealed with its own key: secret_store_key_forked); whether
 * the current key's escrow copy was ever exported (without it, a lost key loses every original); originals still in
 * this host's spool; sealed originals no page or commit references any more; and, on the trusted local path only, held-back publish commits and local refs that still hold
 * commits from before a redaction rebuild. Read-only; never prints a value. A brain with no entries reports ok.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix } from '../check-fix.ts';
import { execFileSync } from '../../../core/spawn.ts';
import { gitChildEnv } from '../../../core/git-env.ts';

const NAME = 'secret_store';
const DOCS = 'docs/guides/secret-store.md#health-and-backups';

/** Held-back publish commits and side refs in one checkout, from git alone; null when git cannot read it. */
function checkoutFindings(root: string, heldTrailer: string, backupPrefix: string): { held: number; side_refs: string[] } | null {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitChildEnv(), timeout: 10_000 }).trim();
  try {
    const held = git('log', '--format=%H', `--grep=^${heldTrailer}:`, 'HEAD', '--not', '--remotes').split('\n').filter(Boolean).length;
    const backups = git('for-each-ref', '--format=%(objectname)', backupPrefix).split('\n').filter(Boolean);
    const side = new Set<string>();
    for (const sha of backups) {
      for (const ref of git('for-each-ref', '--contains', sha, '--format=%(refname)').split('\n')) {
        if (ref && !ref.startsWith('refs/gbrain/') && !ref.startsWith('refs/remotes/')) side.add(ref);
      }
    }
    return { held, side_refs: [...side].sort() };
  } catch { return null; }
}

export async function secretStoreCheck(ctx: DoctorContext): Promise<Check> {
  try { return await inspectSecretStore(ctx); } catch (err) {
    return {
      name: NAME, status: 'warn', fix_unavailable_reason: 'check_errored',
      message: `The secret store could not be checked: ${err instanceof Error ? err.message : String(err)}. Health is unknown.`,
    };
  }
}

async function inspectSecretStore(ctx: DoctorContext): Promise<Check> {
  const engine = connectedEngine(ctx);
  const [{ countsByRule, keysInUse, unreferencedEntryCount }, { keyringStatus, keyById, escrowExported }, { undrainedCount }, { readBackupStatus, storageIdentity }, { HELD_TRAILER, BACKUP_REF_PREFIX }] = await Promise.all([
    import('../../../core/secret-store/store.ts'), import('../../../core/secret-store/keyring.ts'), import('../../../core/secret-store/spool.ts'),
    import('../../../core/secret-store/backup.ts'), import('../../../core/git/redact-unpushed.ts')]);
  let rules: Record<string, { entries: number; occurrences: number }>;
  let inUse: Array<{ key_id: string; key_host: string; entries: number }>;
  let unreferenced: number;
  try { [rules, inUse, unreferenced] = await Promise.all([countsByRule(engine), keysInUse(engine), unreferencedEntryCount(engine)]); } catch {
    return { name: NAME, status: 'ok', message: 'The secret store tables are not there yet (the migration has not run); nothing to check.' };
  }
  const entries = Object.values(rules).reduce((sum, r) => sum + r.entries, 0);
  const occurrences = Object.values(rules).reduce((sum, r) => sum + r.occurrences, 0);
  const spooled = undrainedCount();
  const keyring = keyringStatus();
  const missing = inUse.filter(k => keyById(k.key_id) === null);
  const escrowed = escrowExported();
  const needsEscrow = keyring.origin === 'keyring' && keyring.current !== null && entries > 0 && inUse.some(k => k.key_id === keyring.current) && !escrowed.has(keyring.current);
  const backup = readBackupStatus();
  const { loadConfig } = await import('../../../core/config.ts');
  const storage = loadConfig()?.storage as Parameters<typeof storageIdentity>[0] | undefined;
  const backend = Boolean(storage);
  const backedUpHere = Boolean(storage && backup.last_success?.backend === storageIdentity(storage));
  const backupKeyless = backend && entries > 0 && keyring.current === null;
  const backupFailing = backend && entries > 0 && backup.last_failure !== null && (!backup.last_success || backup.last_failure.at > backup.last_success.at);
  const backupNever = backend && entries > 0 && !backedUpHere;
  const checkouts: Array<{ source_id: string; held: number; side_refs: string[] }> = [];
  if (!ctx.remote) {
    const seen = new Set<string>();
    for (const source of await engine.listAllSources({ localPathOnly: true }).catch(() => [])) {
      const root = source.local_path;
      if (!root || seen.has(root)) continue;
      seen.add(root);
      const found = checkoutFindings(root, HELD_TRAILER, BACKUP_REF_PREFIX);
      if (found && (found.held || found.side_refs.length)) checkouts.push({ source_id: source.id, ...found });
    }
  }
  const held = checkouts.reduce((sum, c) => sum + c.held, 0);
  const sideRefs = checkouts.reduce((sum, c) => sum + c.side_refs.length, 0);
  const details = {
    entries, occurrences, unreferenced, by_rule: rules, spooled, docs: DOCS,
    keys: { origin: keyring.origin, current: keyring.current, present: keyring.keys.filter(k => k.readable).map(k => k.id), in_use: inUse, missing,
      escrow_exported: [...escrowed].sort() },
    backup: { backend, ...backup, carried_by: backend ? 'storage_backend_and_database_backup' : 'database_backup' },
    ...(ctx.remote ? {} : { checkouts }),
  };
  if (entries === 0 && spooled === 0 && missing.length === 0) {
    return { name: NAME, status: 'ok', details, message: 'The secret store holds no entries.' };
  }
  const problems: string[] = [];
  if (missing.length) {
    problems.push(`${missing.reduce((s, k) => s + k.entries, 0)} entr(ies) were sealed with key(s) this host does not have (${missing.map(k => `${k.key_id} from ${k.key_host || 'an unknown host'}`).join(', ')}): secret_store_key_forked. Their originals read only where that key is; import its escrow copy with gbrain secrets key import, or set GBRAIN_SECRET_STORE_KEY to the shared key on every host.`);
  }
  if (unreferenced) problems.push(`${unreferenced} sealed original(s) are referenced by no page or commit any more, so no remote caller can reveal them (only the trusted local gbrain secrets reveal <id> reads them); a page purge removes its own, so these were left by an older purge or by a direct database edit.`);
  if (needsEscrow) problems.push(`The current key ${keyring.current} has never been exported. If this machine's keyring is lost, every original sealed with it is lost; export it with gbrain secrets key export --out <file> --passphrase-stdin and keep the file elsewhere.`);
  if (backupFailing) problems.push(`The last secret store backup failed at ${backup.last_failure!.at} (${backup.last_failure!.message})${backup.last_success ? `; the last success was ${backup.last_success.at}` : ''}. Maintenance tries again; gbrain secrets backup retries now.`);
  else if (backupKeyless) problems.push('This host has no secret store key, so it does not back the store up to the storage backend (a backup is sealed under an existing key and maintenance never makes one); import the store key with gbrain secrets key import, or set GBRAIN_SECRET_STORE_KEY.');
  else if (backupNever) problems.push('A storage backend is configured but the secret store was never backed up to it; maintenance does it after new entries, or run gbrain secrets backup now.');
  if (spooled) problems.push(`${spooled} original(s) wait in this host's encrypted spool for the store; the next maintenance pass or push moves them.`);
  if (held) problems.push(`${held} held-back publish commit(s) keep files on this machine that the remote does not have (${checkouts.filter(c => c.held).map(c => c.source_id).join(', ')}); see gbrain git redact-unpushed --source <id>.`);
  if (sideRefs) problems.push(`${sideRefs} local ref(s) still hold commits from before a redaction rebuild, with the original values (${checkouts.flatMap(c => c.side_refs).slice(0, 5).join(', ')}); delete or rebuild them.`);
  const where = backend
    ? backedUpHere ? `last backed up ${backup.last_success!.at} to the storage backend` : 'not yet backed up to the configured storage backend'
    : 'no storage backend, so the database backup carries the store';
  const summary = `${entries} entr${entries === 1 ? 'y' : 'ies'}, ${occurrences} occurrence(s); ${where}.`;
  if (!problems.length) return { name: NAME, status: 'ok', details, message: `The secret store is healthy: ${summary}` };
  return {
    name: NAME, status: 'warn', details, message: `${summary} ${problems.join(' ')}`,
    fix: agentFix(['gbrain', 'secrets', 'key', 'status', '--json'], 'Lists the keys this host can read and the keys entries need; read-only.', NAME, { docs: DOCS }),
  };
}

async function runSecretStore(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('secret_store');
  checks.push(await secretStoreCheck(ctx));
  return checks;
}

export const secretStoreEntry: DoctorEntry = {
  name: 'secret_store',
  emits: ['secret_store'],
  run: runSecretStore,
};
