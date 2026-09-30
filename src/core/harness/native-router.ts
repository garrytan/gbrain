import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { claudeUserSkillsDir, opencodeConfigDir } from '../bootstrap/host-specs.ts';
import { assertNoSymlinks, checkedRoot, confinedPath, privateWrite, sha256 } from '../agent-install/state.ts';
import { acquireNativeLock } from '../persistence/native-lock.ts';
import { OperationError } from '../ops/contract.ts';
import { harnessAdapter } from './registry.ts';

interface RouterIdentity { brain_id: string; installation_id: string; adapter: string }
interface NativeRouterReceipt extends RouterIdentity {
  version: 1;
  name: string;
  skills_dir: string;
  owned_hash: string | null;
  pending?: { before: string | null; after: string };
  state: 'prepared' | 'installed' | 'removed';
}
export interface NativeRouterPlan extends RouterIdentity {
  state_root: string;
  skills_dir: string;
  name: string;
  path: string;
  content: string;
}

export function nativeSharedSkillsDirectory(harness: string): string | null {
  const id = harnessAdapter(harness).id;
  if (id === 'claude-code') return claudeUserSkillsDir();
  if (id === 'codex') return join(process.env.HOME?.trim() || homedir(), '.agents', 'skills');
  if (id === 'opencode') return join(opencodeConfigDir(), 'skills');
  return null;
}

function conflict(): never { throw new OperationError('local_conflict', 'The native shared-brain router is unowned, edited, or bound to another installation. Preserve it before retrying.'); }
function readReceipt(root: string): NativeRouterReceipt | null {
  const path = confinedPath(root, 'native-router.json');
  if (!existsSync(path)) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 65_536) return conflict();
    const value = JSON.parse(readFileSync(path, 'utf8')) as NativeRouterReceipt;
    if (value.version !== 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name) || !['prepared', 'installed', 'removed'].includes(value.state)) return conflict();
    checkedRoot(value.skills_dir);
    return value;
  } catch { return conflict(); }
}
function hashAt(path: string): string | null {
  assertNoSymlinks(path);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 256 * 1024) return conflict();
  return sha256(readFileSync(path));
}
export function recordedNativeSkillsDirectory(stateRoot: string): string | undefined {
  return readReceipt(checkedRoot(stateRoot))?.skills_dir;
}
function validate(plan: NativeRouterPlan): NativeRouterReceipt | null {
  const prior = readReceipt(plan.state_root);
  if (prior && (prior.name !== plan.name || prior.skills_dir !== plan.skills_dir || prior.brain_id !== plan.brain_id ||
    prior.installation_id !== plan.installation_id || prior.adapter !== plan.adapter)) return conflict();
  const current = hashAt(plan.path);
  const directory = confinedPath(plan.skills_dir, plan.name);
  if (!prior && existsSync(directory) && readdirSync(directory).length) return conflict();
  if (current !== null && (!prior || ![prior.owned_hash, prior.pending?.before, prior.pending?.after].includes(current))) return conflict();
  return prior;
}

export function prepareNativeRouter(input: RouterIdentity & { state_root: string; skills_dir: string; connection_name: string; content: string }): NativeRouterPlan {
  const state_root = checkedRoot(input.state_root);
  const skills_dir = checkedRoot(input.skills_dir);
  const name = `gbrain-shared-${sha256(JSON.stringify([input.brain_id, input.installation_id, input.adapter, input.connection_name])).slice(0, 24)}`;
  if (!input.content.startsWith('---\nname: gbrain-shared-router\n')) return conflict();
  const plan = { ...input, state_root, skills_dir, name, path: confinedPath(skills_dir, `${name}/SKILL.md`),
    content: input.content.replace('name: gbrain-shared-router\n', `name: ${name}\n`) };
  validate(plan);
  return plan;
}

export async function installNativeRouter(plan: NativeRouterPlan): Promise<{ path: string; registration: 'installed'; activation: 'unverified' }> {
  assertNoSymlinks(plan.skills_dir);
  mkdirSync(plan.skills_dir, { recursive: true, mode: 0o700 });
  const lock = await acquireNativeLock(confinedPath(plan.skills_dir, `.gbrain-${plan.name}.lock`), { timeoutMs: 5000 });
  if (!lock) return conflict();
  try {
    const prior = validate(plan);
    const after = sha256(plan.content);
    const receipt: NativeRouterReceipt = { version: 1, adapter: plan.adapter, brain_id: plan.brain_id, installation_id: plan.installation_id,
      name: plan.name, skills_dir: plan.skills_dir, owned_hash: prior?.owned_hash ?? null, pending: { before: hashAt(plan.path), after }, state: 'prepared' };
    const save = () => privateWrite(confinedPath(plan.state_root, 'native-router.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    save();
    if (hashAt(plan.path) !== after) privateWrite(plan.path, plan.content);
    receipt.owned_hash = after; delete receipt.pending; receipt.state = 'installed'; save();
    return { path: plan.path, registration: 'installed', activation: 'unverified' };
  } finally { await lock.release(); }
}

export async function removeNativeRouter(stateRoot: string, identity: RouterIdentity): Promise<{ retained: boolean }> {
  const root = checkedRoot(stateRoot);
  const prior = readReceipt(root);
  if (!prior) return { retained: false };
  if (prior.brain_id !== identity.brain_id || prior.installation_id !== identity.installation_id || prior.adapter !== identity.adapter) return { retained: true };
  const lock = await acquireNativeLock(confinedPath(prior.skills_dir, `.gbrain-${prior.name}.lock`), { timeoutMs: 5000 });
  if (!lock) return { retained: true };
  try {
    const path = confinedPath(prior.skills_dir, `${prior.name}/SKILL.md`);
    const current = hashAt(path);
    if (current !== null && current !== prior.owned_hash && current !== prior.pending?.after) return { retained: true };
    if (current !== null) unlinkSync(path);
    const dir = confinedPath(prior.skills_dir, prior.name);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    prior.state = 'removed'; prior.owned_hash = null; delete prior.pending;
    privateWrite(confinedPath(root, 'native-router.json'), `${JSON.stringify(prior, null, 2)}\n`);
    return { retained: false };
  } finally { await lock.release(); }
}
