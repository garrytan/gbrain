/**
 * #5878: shared-skills enrollment refresh for bootstrap-managed installations.
 *
 * `gbrain bootstrap harness --refresh-skills` re-runs the adapter's join for
 * every live shared-skills entry on the harness receipt, under that entry's
 * own stored credential and follow policy, so the local receipt and the
 * native router adopt the server's current enrollment epoch (an MCP
 * leave/join by the same principal moves the epoch on and leaves the router
 * calling `sync_brain_skills` with a superseded one). No token is minted or
 * revoked. `localEnrollment` is the one reader of the adapter receipt's
 * epoch, shared with `--status` and doctor.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCredentials } from '../harness/credentials.ts';
import { redactToken } from '../mcp-registration.ts';
import type { BrainEngine } from '../engine.ts';
import { createEngine } from '../engine-factory.ts';
import { loadConfig, toEngineConfig } from '../config.ts';
import { probeLivePgliteHolder } from './uninstall.ts';
import { readHarnessReceiptState, writeHarnessReceipt, type HarnessReceipt } from './format.ts';
import { resolveHarnessDeps, type HarnessDeps } from './harness.ts';

export const SKILLS_REFRESH_COMMAND = 'gbrain bootstrap harness --refresh-skills';
export const SKILLS_EPOCH_DOCS = 'docs/guides/shared-brain-skills.md#membership-inactive-after-a-re-enrollment';

/** The adapter receipt's enrollment, or undefined when the entry never enrolled. */
export function localEnrollment(root: string): { installation_id: string; enrollment_epoch: number } | undefined {
  const path = join(root, 'shared-skills', 'receipt.json');
  if (!existsSync(path)) return undefined;
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8')) as { installation_id?: unknown; enrollment_epoch?: unknown };
    if (typeof receipt.installation_id !== 'string' || !Number.isSafeInteger(receipt.enrollment_epoch)) return undefined;
    return { installation_id: receipt.installation_id, enrollment_epoch: receipt.enrollment_epoch as number };
  } catch {
    return undefined;
  }
}

export async function refreshHarnessSkills(rawDeps: HarnessDeps): Promise<number> {
  const d = resolveHarnessDeps(rawDeps);
  const state = readHarnessReceiptState(d.gbrainHome);
  if (state.state !== 'ok') {
    d.logError(`no readable harness receipt (${state.state}); run \`gbrain bootstrap harness\` first.`);
    return 1;
  }
  const receipt = state.receipt;
  const entries = (receipt.shared_skills ?? []).filter(entry => !entry.status.startsWith('left') && localEnrollment(entry.root));
  if (entries.length === 0) {
    d.log('no shared-skills enrollment to refresh (skills policy follow enrolls on the next `gbrain bootstrap harness`).');
    return 0;
  }
  let ok = true;
  for (const entry of entries) {
    const before = localEnrollment(entry.root)!.enrollment_epoch;
    let token = '';
    try {
      const credentials = readCredentials(join(entry.root, 'credentials.json'));
      token = credentials.access_token ?? '';
      if (credentials.mcp_url !== entry.url) throw new Error('credential endpoint mismatch');
      const result = await d.installSharedSkills(credentials, {
        harness: entry.host, root: entry.root, name: entry.name, nativeSkillsDir: d.nativeSkillsDir(entry.host),
      });
      entry.status = result.status;
      entry.reason = result.reason ? redactToken(result.reason, token) : undefined;
      const after = localEnrollment(entry.root)?.enrollment_epoch ?? before;
      const refreshed = ['restart_required', 'advisory_refresh'].includes(result.status);
      ok = ok && refreshed;
      const line = `shared skills (${entry.host}): enrollment epoch ${before}${after !== before ? ` -> ${after}` : ' (current)'}; ` +
        `${result.status}${entry.reason ? ` — ${entry.reason}` : ''}. ${result.next_action ?? ''}`.trim();
      (refreshed ? d.log : d.logError)(redactToken(line, token));
    } catch (error) {
      ok = false;
      entry.status = 'pending';
      entry.reason = 'shared_skills_unavailable';
      d.logError(redactToken(`shared skills (${entry.host}): refresh failed (${error instanceof Error ? error.message : String(error)}); ` +
        'memory remains independent. Re-run `gbrain bootstrap harness` to re-enroll with a fresh credential.', token));
    }
    writeHarnessReceipt(d.gbrainHome, receipt);
  }
  return ok ? 0 : 1;
}

/**
 * Doctor's comparison (read-only): live harness entries whose adapter receipt
 * epoch differs from this brain's membership row, or whose membership is no
 * longer active. Installations this brain does not hold are skipped.
 */
export async function supersededEnrollments(engine: Pick<BrainEngine, 'executeRaw'>, receipt: HarnessReceipt): Promise<Array<{
  host: string; installation_id: string; local_epoch: number; server_epoch: number; active: boolean;
}>> {
  const out = [];
  for (const entry of receipt.shared_skills ?? []) {
    if (entry.status.startsWith('left')) continue;
    const local = localEnrollment(entry.root);
    if (!local) continue;
    const [row] = await engine.executeRaw<{ epoch: number | string; active: boolean }>(
      'SELECT epoch, active FROM shared_skill_members WHERE installation_id = $1::uuid', [local.installation_id]);
    if (row && (Number(row.epoch) !== local.enrollment_epoch || row.active !== true)) {
      out.push({ host: entry.host, installation_id: local.installation_id, local_epoch: local.enrollment_epoch, server_epoch: Number(row.epoch), active: row.active === true });
    }
  }
  return out;
}

/** #6798: supersededEnrollments against the configured brain; throws when it cannot be opened (a live PGLite serve holds it). */
export async function brainSupersededEnrollments(receipt: HarnessReceipt): ReturnType<typeof supersededEnrollments> {
  const cfg = loadConfig();
  if (!cfg) throw new Error('no brain configured');
  if (cfg.database_path && probeLivePgliteHolder(cfg.database_path) !== null) throw new Error('a live gbrain serve holds this PGLite brain');
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    return await supersededEnrollments(engine, receipt);
  } finally {
    await engine.disconnect();
  }
}
