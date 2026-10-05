import type { BrainEngine } from '../engine.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { SOURCE_CONFIG_OBJECT_SQL } from '../source-config-sql.ts';
import { migrationCheckpointKey, parkedReason, type SharedSourceMigration, type SharedSourceParked } from './migration.ts';
import { SHARED_SKILLS_OPT_OUT_DOCS, sharedSkillSourcePolicyOrPreserve } from './setup-source-policy.ts';

export type SharedSkillsAction = 'on' | 'off' | 'status';

/** What `gbrain sources shared-skills <id> status`, `sources status` and doctor report for one source. */
export interface SharedSkillsSourceView {
  source_id: string;
  /** `config.shared_skills` as stored: false (opted out), true, or null (unset, the default: on). */
  configured: boolean | null;
  mode: 'content' | 'explicit_pack_required' | 'preserve_files';
  reason_code: string | null;
  reason: string | null;
  explanation: string;
  parked: (SharedSourceParked & { resume: string }) | null;
}

const statusArgv = (sourceId: string) => ['gbrain', 'sources', 'shared-skills', sourceId, 'status', '--json'];

export function sharedSkillsNotFound(sourceId: string): OperationError {
  return opError('not_found', `Source "${sourceId}" was not found (or is archived).`, 'List the registered sources, then run sources shared-skills with one of their ids.',
    { fix: readFix('Lists the registered sources and their ids, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
}

/** A remote caller (thin client or MCP) cannot change or read the host's source policy. */
export function sharedSkillsRemoteRefusal(sourceId: string, action: SharedSkillsAction): OperationError {
  const argv = ['gbrain', 'sources', 'shared-skills', sourceId, action];
  return opError('trusted_local_only', `sources shared-skills runs only from the trusted local CLI on the brain host.`,
    `Ask the brain host's operator to run \`${argv.join(' ')}\` on the brain host.`, {
      why: 'A source\'s shared-skills setting decides whether the host migration may write skills into that repository, so only the brain host can read or change it.',
      fix: { argv, consent: [], actor: 'host_admin', requires_exclusive: false, docs: SHARED_SKILLS_OPT_OUT_DOCS,
        why: 'Runs on the brain host, which owns the source configuration.', verify: { argv: statusArgv(sourceId) } },
    });
}

async function readRecord(engine: BrainEngine, sourceId: string, incarnation: string): Promise<SharedSourceMigration | null> {
  const raw = await engine.getConfig(migrationCheckpointKey(sourceId, incarnation));
  if (!raw) return null;
  try { return JSON.parse(raw) as SharedSourceMigration; } catch { return null; }
}

export async function readSharedSkillsSourceView(engine: BrainEngine, sourceId: string): Promise<SharedSkillsSourceView> {
  const [source] = await engine.executeRaw<{ config: unknown; incarnation: string }>('SELECT config,incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId]);
  if (!source) throw sharedSkillsNotFound(sourceId);
  const stored = parseSourceConfig(source.config).shared_skills;
  const configured = typeof stored === 'boolean' ? stored : null;
  const policy = await sharedSkillSourcePolicyOrPreserve(engine, sourceId);
  const reasonCode = policy.mode === 'content' ? null : policy.reason.split(':')[0]!;
  const record = await readRecord(engine, sourceId, source.incarnation);
  const parked = policy.mode !== 'preserve_files' && record?.parked ? { ...record.parked, resume: parkedReason(sourceId, record.parked) } : null;
  const explanation = policy.mode === 'content'
    ? `Shared skills are on for ${sourceId}: the migration may inventory and adopt its skillpack. Opt out with gbrain sources shared-skills ${sourceId} off.`
    : configured === false
      ? `${sourceId} opted out with config.shared_skills=false, so the migration preserves its files. Turn adoption back on with gbrain sources shared-skills ${sourceId} on.`
      : `config.shared_skills is ${configured === null ? 'unset (on)' : 'true'}, but ${sourceId} stays ${policy.mode} because of ${reasonCode}; turning shared skills on cannot change that. ${policy.reason}`;
  return { source_id: sourceId, configured, mode: policy.mode, reason_code: reasonCode, reason: policy.mode === 'content' ? null : policy.reason, explanation, parked };
}

/** Human lines shared by `sources shared-skills` and `sources status`. */
export function sharedSkillsStatusLines(view: SharedSkillsSourceView): string[] {
  return [
    `${view.source_id}: config.shared_skills = ${view.configured === null ? 'unset (on)' : String(view.configured)}; effective policy ${view.mode}${view.reason_code ? ` (${view.reason_code})` : ''}`,
    `  ${view.explanation}`,
    ...(view.parked ? [`  parked inventory since ${view.parked.parked_at} (${view.parked.limit}): ${view.parked.resume}`] : []),
  ];
}

/**
 * `off` writes config.shared_skills=false. `on` deletes the key and releases a
 * parked inventory so the next migration run inventories the source again.
 * Trusted local CLI only.
 */
export async function setSourceSharedSkills(ctx: { engine: BrainEngine; remote: boolean }, sourceId: string, enabled: boolean): Promise<SharedSkillsSourceView & { changed: boolean; released_parked: boolean }> {
  if (ctx.remote !== false) throw sharedSkillsRemoteRefusal(sourceId, enabled ? 'on' : 'off');
  const before = await readSharedSkillsSourceView(ctx.engine, sourceId);
  await ctx.engine.executeRaw(enabled
    ? `UPDATE sources SET config = ${SOURCE_CONFIG_OBJECT_SQL} - 'shared_skills' WHERE id = $1 AND NOT archived`
    : `UPDATE sources SET config = ${SOURCE_CONFIG_OBJECT_SQL} || '{"shared_skills": false}'::jsonb WHERE id = $1 AND NOT archived`, [sourceId]);
  let released = false;
  if (enabled) {
    const [source] = await ctx.engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const record = source ? await readRecord(ctx.engine, sourceId, source.incarnation) : null;
    if (source && record?.parked) {
      delete record.parked;
      await ctx.engine.setConfig(migrationCheckpointKey(sourceId, source.incarnation), JSON.stringify(record));
      released = true;
    }
  }
  const after = await readSharedSkillsSourceView(ctx.engine, sourceId);
  return { ...after, changed: before.configured !== after.configured || released, released_parked: released };
}
