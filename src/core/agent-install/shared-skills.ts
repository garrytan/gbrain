import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from '../ops/contract.ts';
import { createSharedSkillsAdapter, type SharedSkillsToolCaller } from '../shared-skills/adapter.ts';
import { withVerifiedLocalRegistration, type LocalRegistration } from '../persistence/identity.ts';
import { readPrivateText } from '../harness/credentials.ts';
import { checkedRoot, confinedPath, type AgentHarness } from './state.ts';

export interface LocalSharedSkillsResult {
  status: 'pending' | 'memory_only';
  reason: string;
  native: 'unverified';
  catalog_delivery?: string;
  router_path?: string;
  retained_files?: string[];
  next_action: string;
}

export async function installLocalSharedSkills(ctx: OperationContext, options: {
  root: string;
  harness: AgentHarness;
  sourceId: string;
  follow: boolean;
}): Promise<LocalSharedSkillsResult> {
  const root = checkedRoot(options.root);
  const state = confinedPath(root, '.gbrain/agent-install/shared-skills');
  const base = { native: 'unverified' as const };
  if (!options.follow && !existsSync(join(state, 'receipt.json'))) return {
    ...base, status: 'memory_only', reason: 'memory_only',
    next_action: 'Keep using memory. Explicitly approve shared-skills following through the installation setup helper before enrollment.',
  };
  if (ctx.remote !== false || ctx.sourceId !== options.sourceId || ctx.config.remote_mcp) return {
    ...base, status: 'pending', reason: 'installation_context_required',
    next_action: 'Use the installation-bound local setup or the approved remote private-handoff installer; do not borrow an ambient credential.',
  };
  try {
    const [brain] = await ctx.engine.executeRaw<{ brain_id: string; skill_bundles_enabled: boolean }>('SELECT brain_id,skill_bundles_enabled FROM persistence_brain WHERE singleton=1');
    if (!brain?.skill_bundles_enabled && options.follow) return {
      ...base, status: 'pending', reason: 'shared_content_migration_required',
      next_action: 'The selected brain is memory-capable but shared content is not active. Review and approve its content migration before following.',
    };
    if (!brain || !/^[a-f0-9-]{36}$/i.test(brain.brain_id)) throw new Error('missing installation brain identity');
    const { operationsByName } = await import('../operations.ts');
    const allowed = new Set(['join_brain', 'sync_brain_skills', 'leave_brain', 'get_skill', 'get_skill_asset']);
    const call: SharedSkillsToolCaller = async <T>(name: string, params: Record<string, unknown>): Promise<T> => {
      if (!allowed.has(name) || !operationsByName[name]) throw new Error('unsupported shared-skills operation');
      const registration = JSON.parse(readPrivateText(confinedPath(root, `.gbrain/persistence/${brain.brain_id}.cli.json`), 65536)) as LocalRegistration;
      if (registration.lane !== 'cli' || typeof registration.id !== 'string' || typeof registration.credential !== 'string') throw new Error('invalid local CLI identity');
      return await withVerifiedLocalRegistration(ctx.engine, registration, async () => await operationsByName[name].handler(ctx, params) as T);
    };
    const adapter = createSharedSkillsAdapter({ call, root: state, adapter: options.harness, launcher: join(root, 'bin', 'gbrain') });
    if (!options.follow) {
      const result = await adapter.leave();
      if ('remote_membership_pending' in result && result.remote_membership_pending) return { ...base, status: 'pending', reason: 'remote_membership_pending',
        retained_files: result.retained_files, next_action: 'Owned local files were cleaned up, but enrollment closure is pending. Repair this installation’s writer access and retry; native saved instructions must be updated manually.' };
      return { ...base, status: 'memory_only', reason: result.status, retained_files: result.retained_files,
        next_action: 'Shared following is stopped. Preserve any retained edits and update the native saved instruction manually; no native removal is claimed.' };
    }
    const result = await adapter.join({ approved: true, source_ids: [options.sourceId] });
    return { ...base, status: 'pending', reason: 'native_registration_required', catalog_delivery: result.status,
      router_path: result.router_path, next_action: 'Load the generated shared router into the native saved skill, then test a new conversation. Catalog installation does not prove native activation.' };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const conflict = ['local_conflict', 'invalid_path', 'symlink_path', 'invalid_root'].includes(code ?? '');
    return { ...base, status: 'pending', reason: conflict ? 'local_conflict' : 'local_enrollment_unavailable',
      next_action: conflict ? 'Preserve the edited or unowned shared router/cache before retrying. No existing instructions were overwritten.'
        : 'Keep using memory. Verify this installation’s private local CLI registration and shared publication approval, then rerun setup; do not activate stale cached skills.' };
  }
}
