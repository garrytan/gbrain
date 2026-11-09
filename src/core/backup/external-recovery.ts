import { closeSync, constants, fstatSync, openSync, readFileSync, lstatSync } from 'node:fs';
import { gbrainPath } from '../config.ts';
import type { BrainEngine } from '../engine.ts';

export interface ExternalRecoveryEvidence {
  snapshot_at: string;
  restore_verified_at: string;
}

const MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1000;
const COMMIT = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function proofPath(): string {
  return gbrainPath('backup', 'external-recovery.json');
}

export function externalRecoveryCurrent(evidence: ExternalRecoveryEvidence, now: number): boolean {
  const snapshot = Date.parse(evidence.snapshot_at);
  const restored = Date.parse(evidence.restore_verified_at);
  return Number.isFinite(snapshot) && Number.isFinite(restored) &&
    snapshot <= restored && restored <= now && now - snapshot <= MAX_SNAPSHOT_AGE_MS;
}

export function externalRecoveryChanged(cacheAt: string, hadProof: boolean): boolean {
  try {
    const info = lstatSync(proofPath());
    const owned = process.getuid !== undefined && info.isFile() &&
      info.uid === process.getuid() && (info.mode & 0o077) === 0;
    return owned ? info.mtimeMs > Date.parse(cacheAt) : hadProof;
  } catch {
    return hadProof;
  }
}

/** This is host-admin attestation, never a remote parameter or a Git probe. */
export async function readExternalRecovery(
  engine: BrainEngine, now: number,
): Promise<ExternalRecoveryEvidence | null> {
  if (engine.kind !== 'postgres' || process.getuid === undefined) return null;
  try {
    const fd = openSync(proofPath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: unknown;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 4096) return null;
      raw = JSON.parse(readFileSync(fd, 'utf8'));
    } finally {
      closeSync(fd);
    }
    if (raw === null || typeof raw !== 'object') return null;
    const proof = raw as Record<string, unknown>;
    if (proof.version !== 1 || proof.scope !== 'postgres_and_canonical_files' ||
        proof.verification !== 'remote_cipher_decrypted_restore' || proof.source_id !== 'default' || typeof proof.brain_id !== 'string' || !UUID.test(proof.brain_id) ||
        typeof proof.source_incarnation !== 'string' || !UUID.test(proof.source_incarnation) ||
        typeof proof.remote_commit !== 'string' || !COMMIT.test(proof.remote_commit) ||
        proof.restored_commit !== proof.remote_commit ||
        typeof proof.snapshot_at !== 'string' || typeof proof.restore_verified_at !== 'string') return null;
    const evidence = { snapshot_at: proof.snapshot_at, restore_verified_at: proof.restore_verified_at };
    if (!externalRecoveryCurrent(evidence, now)) return null;
    const [row] = await engine.executeRaw<{ brain_id: string; source_incarnation: string }>(
      `SELECT b.brain_id::text, s.incarnation::text AS source_incarnation
       FROM persistence_brain b CROSS JOIN sources s
       WHERE b.singleton=1 AND s.id='default' AND s.archived IS NOT TRUE`,
    );
    return row?.brain_id === proof.brain_id && row.source_incarnation === proof.source_incarnation ? evidence : null;
  } catch {
    return null;
  }
}
