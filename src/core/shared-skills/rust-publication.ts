/**
 * Shared-skill publication on a Rust brain (rust/docs/store/shared-skill-members.md, "Publication"). The store keeps
 * the activation flag, the sealed pack row, heads and revisions; publication.ts asks these helpers where a SQL brain
 * runs its statements. A Rust brain has no worktree coordinator: the canonical root is the source's registered
 * local_path, and a publication commits its revisions, pack row and receipt in one store transaction, then replaces
 * the canonical files it staged before that commit (rust-canonical-files.ts).
 */
import type { BrainEngine } from '../engine.ts';
import type { RustEngine } from '../rust-engine.ts';
import { storeCall } from '../rust-engine/store-members/common.ts';
import type { StoreBrain } from '../rust-engine/store.ts';
import type { SkillRetentionCapacity, SkillRetentionStatus } from './retention.ts';
import { SHARED_SKILL_RETENTION_LIMITS, type StoredSkillRevision } from './model.ts';

export function isRustBrain(engine: unknown): boolean {
  return (engine as { kind?: unknown }).kind === 'rust';
}

/** A Rust brain this process reaches as a client of its owner (gbrain serve): the skill store here is the owner's alone. */
export function isRustClient(engine: unknown): boolean {
  return isRustBrain(engine) && (engine as { ownerRole?: unknown }).ownerRole === 'client';
}

async function call<T>(engine: BrainEngine, member: string, run: (brain: StoreBrain) => Promise<unknown>): Promise<T> {
  const rust = engine as unknown as RustEngine & { _admit(member: string): Promise<void>; storeFor(member: string): Promise<{ brain: StoreBrain }> };
  await rust._admit(member);
  const brain = (await rust.storeFor(member)).brain;
  return await storeCall({ member }, () => run(brain)) as T;
}

export interface RustSkillSource { id: string; incarnation: string; archived: boolean; local_path: string | null; aliases: string[] }
export interface RustPackRow { pack_id: string; revision: string; manifest: Record<string, unknown>; manifest_hash: string }
type HeadKey = Pick<StoredSkillRevision, 'name' | 'revision' | 'deleted'>;

export const rustSource = (engine: BrainEngine, sourceId: string) =>
  call<RustSkillSource | null>(engine, 'readSharedSkillSource', brain => brain.readSharedSkillSource(sourceId));

export const rustPack = async (engine: BrainEngine, sourceId: string, incarnation: string) =>
  (await call<RustPackRow | null>(engine, 'readSharedSkillPack', brain => brain.readSharedSkillPack({ sourceId, incarnation }))) ?? undefined;

export const rustHeadKeys = (engine: BrainEngine, sourceId: string, incarnation: string, packId: string, limit: number) =>
  call<HeadKey[]>(engine, 'listSharedSkillHeadKeys', brain => brain.listSharedSkillHeadKeys({ sourceId, incarnation, packId, limit, names: [] }));

export async function rustHeads(engine: BrainEngine, sourceId: string, incarnation: string, packId: string, names: string[]): Promise<StoredSkillRevision[]> {
  const rows = await call<Array<StoredSkillRevision & { created_at: string }>>(engine, 'readSharedSkillHeadRevisions',
    brain => brain.readSharedSkillHeadRevisions({ sourceId, incarnation, packId, limit: names.length, names }));
  return rows.map(row => ({ ...row, created_at: new Date(row.created_at) }) as StoredSkillRevision);
}

export type RustCheck = { conflict: 'pack' | 'head' } | { pruned: number; capacity: SkillRetentionCapacity; incoming_bytes: number };

/** The CAS on the pack and the affected heads, the source's retention prune and the incoming bytes, in one store write. */
export const rustCheck = (engine: BrainEngine, check: { sourceId: string; incarnation: string; packId: string; expectedPackRevision: string | null;
  heads: Array<{ name: string; revision: string | null }>; revisions: Array<{ metadata: unknown; files: unknown }> }) =>
  call<RustCheck>(engine, 'checkSharedSkillPublication', brain => brain.checkSharedSkillPublication(check));

export const rustWritePack = (engine: BrainEngine, write: { sourceId: string; incarnation: string; packId: string; revision: string;
  manifest: Record<string, unknown>; manifestHash: string }) =>
  call<void>(engine, 'writeSharedSkillPack', brain => brain.writeSharedSkillPack(write));

/** sharedSkillRetentionStatus's answer from the store's counts. */
export async function rustRetention(engine: BrainEngine, sourceId: string, incarnation: string): Promise<SkillRetentionStatus> {
  const row = await call<Omit<SkillRetentionStatus, 'source_id' | 'source_incarnation' | 'pruned_revisions' | 'capacity_blocked' | 'limits'>>(engine,
    'readSharedSkillRetention', brain => brain.readSharedSkillRetention({ sourceId, incarnation }));
  const limits = SHARED_SKILL_RETENTION_LIMITS;
  return { source_id: sourceId, source_incarnation: incarnation, ...row, pruned_revisions: 0,
    capacity_blocked: row.retained_revisions >= limits.sourceRevisions || row.retained_bytes >= limits.sourceBytes
      || row.brain_retained_revisions >= limits.brainRevisions || row.brain_retained_bytes >= limits.brainBytes,
    limits };
}

export const rustPublicationFlag = (engine: BrainEngine) =>
  call<{ skill_bundles_enabled: boolean; writer_protocol_floor: number }>(engine, 'readSharedSkillPublication', brain => brain.readSharedSkillPublication());

export interface RustBlocker {
  phase: 'managed' | 'skill'; kind: 'request' | 'effect'; request_id: string; source_id: string; slug: string;
  operation?: string; state: string; effect_id?: string; effect_kind?: string; recovering?: boolean; attempts?: number; next_attempt_at?: string | null;
}
export type RustActivation = { registration_required: true } | { legacy_lock: true } | { blocked: RustBlocker }
  | { activated: boolean; protocol_version: 2; filesystem_sources: number };

/** The quiescence checks and the flag write of shared-publication activation, in one store write. */
export const rustActivate = (engine: BrainEngine, dryRun: boolean) =>
  call<RustActivation>(engine, 'activateSharedSkillPublication', brain => brain.activateSharedSkillPublication(dryRun));
