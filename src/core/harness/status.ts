import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { harnessAdapter } from './registry.ts';
import { claudeUserMcpConfigPath, codexConfigPath, opencodeGlobalConfigPath } from '../bootstrap/host-specs.ts';
import { assertNoSymlinks, checkedRoot, sha256 } from '../agent-install/state.ts';
import { isValidName } from '../mcp-registration.ts';
import type { SharedSkillsLocalReceipt } from '../shared-skills/adapter.ts';

export interface HarnessStatusOptions { harness: string; name?: string; root?: string; configPath?: string }

export function harnessSharedSkillsRoot(options: HarnessStatusOptions): string | null {
  const adapter = harnessAdapter(options.harness);
  const name = options.name ?? 'gbrain';
  if (!isValidName(name)) throw new Error('Invalid connection name');
  if (adapter.connection === 'manual') return null;
  if (adapter.connection === 'thin-cli') {
    if (!options.root) throw new Error('An explicit persistent root is required for this harness.');
    return join(checkedRoot(options.root), '.gbrain');
  }
  const config = options.configPath ?? (adapter.connection === 'claude-json' ? claudeUserMcpConfigPath()
    : adapter.connection === 'codex-toml' ? codexConfigPath() : opencodeGlobalConfigPath());
  assertNoSymlinks(config);
  return join(dirname(config), `.gbrain-${adapter.id}-${name}`);
}

export function readHarnessConnectionStatus(options: HarnessStatusOptions) {
  const harness = harnessAdapter(options.harness).id;
  const root = harnessSharedSkillsRoot(options);
  const common = { harness, current_authority: 'unprobed', native_use: 'unverified' } as const;
  if (!root) return { ...common, status: 'pending', reason: 'manual_configuration_required' };
  const path = join(root, 'shared-skills', 'receipt.json');
  assertNoSymlinks(path);
  if (!existsSync(path)) return { ...common, status: 'not_enrolled', next_action: 'Approve following shared skills and install inside this harness if desired. Memory configuration is independent.' };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Invalid shared-skills receipt');
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as SharedSkillsLocalReceipt;
  if (receipt.format_version !== 1 || receipt.adapter !== harness) throw new Error('Shared-skills receipt does not match this harness');
  const recorded_skills: Array<{ key: string; revision: string }> = [];
  let local_reference: 'owned' | 'absent' | 'conflict' = 'absent';
  const activePath = join(root, 'shared-skills', 'active.json');
  assertNoSymlinks(activePath);
  if (existsSync(activePath)) {
    local_reference = 'conflict';
    const activeStat = lstatSync(activePath);
    if (activeStat.isFile() && activeStat.size <= 8 * 1024 * 1024) {
      const content = readFileSync(activePath, 'utf8');
      if (sha256(content) === receipt.owned_files?.['active.json']) {
        const active = JSON.parse(content) as { brain_id?: string; installation_id?: string; enrollment_epoch?: number; skills?: Record<string, { revision?: unknown }> };
        if (active.brain_id === receipt.brain_id && active.installation_id === receipt.installation_id && active.enrollment_epoch === receipt.enrollment_epoch && active.skills) {
          local_reference = 'owned';
          for (const [key, skill] of Object.entries(active.skills)) {
            if (typeof skill.revision === 'string') recorded_skills.push({ key, revision: skill.revision });
          }
        }
      }
    }
  }
  return { ...common, status: receipt.status, brain_id: receipt.brain_id, installation_id: receipt.installation_id,
    enrollment_epoch: receipt.enrollment_epoch, desired_view: receipt.desired_view ?? null, installed_view: receipt.installed_view ?? null,
    acknowledged_view: receipt.acknowledged_view ?? null, last_authority_check: receipt.last_authority_check ?? null,
    native_registration: receipt.native_registration, freshness: receipt.freshness, local_reference, recorded_skills, usability: 'last_checked_unverified',
    blocked_skills: receipt.blocked_skills ?? [],
    retained_file_count: receipt.retained_files?.length ?? 0, pending_file_count: Object.keys(receipt.pending_files ?? {}).length,
    remote_membership_pending: receipt.remote_membership_pending ?? false, remote_membership_reason: receipt.remote_membership_reason ?? null,
    next_action: receipt.next_action };
}
