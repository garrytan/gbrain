/**
 * hermes-turn-hook.ts — Hermes's native per-turn hook for the brain-first
 * rule: a marked `hooks.pre_llm_call` shell hook in $HERMES_HOME/config.yaml
 * that echoes `{"context": <rule>}`, which Hermes appends to every user
 * message. The block in SOUL.md reaches the system prompt only, and bots read
 * it as identity; this puts the same rule next to each turn. The command is
 * self-contained (no gbrain process per turn, no path that must exist on the
 * Hermes host), so a re-run after an upgrade rewrites it with the new text.
 *
 * Ownership is by YAML comment markers; text outside them is never touched.
 * gbrain appends its block only when config.yaml has no top-level `hooks:`
 * key (a second one would be invalid YAML) and prints the entry to add by
 * hand otherwise. Hermes runs a shell hook only after approval, so setup
 * records the approval for this exact command in Hermes's own allowlist, the
 * way `gbrain setup codex` writes its hook trust entries. Removal strips the
 * block and that approval.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { acquireNativeLockSync } from '../persistence/native-lock.ts';
import { loadBoundedYaml } from '../data-frontmatter.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { renderBrainFirstTurnRule, writeUnlessChanged, type BrainFirstAccess } from './brain-first.ts';

const MARKERS: BlockMarkers = { begin: '# gbrain:turn-rule:begin', end: '# gbrain:turn-rule:end', label: 'turn-rule', rerun: 'gbrain setup hermes --instructions-only' };
const EVENT = 'pre_llm_call';
const ALLOWLIST = 'shell-hooks-allowlist.json';

export interface HermesTurnHookOutcome { action: 'write' | 'keep' | 'print' | 'remove' | 'skip'; path: string; detail: string; snippet?: string }

/** `/bin/echo '<json>'`: Hermes splits the command without a shell (and checks the first path, /bin/echo, exists), and a quote in the rule is a JSON escape. */
export function hermesTurnHookCommand(access: BrainFirstAccess): string {
  return `/bin/echo '${JSON.stringify({ context: renderBrainFirstTurnRule(access, 'hermes') }).replace(/'/g, '\\u0027')}'`;
}

const commandIn = (interior: string | undefined): string | null => {
  const quoted = /command: (".*")/.exec(interior ?? '')?.[1];
  return quoted ? (JSON.parse(quoted) as string) : null;
};

function hookYaml(command: string): string {
  return `hooks:\n  ${EVENT}:\n    - command: ${JSON.stringify(command)}\n      timeout: 10\n`;
}

interface Allowlist { approvals: Array<Record<string, unknown>> }

/** Throws on a file gbrain cannot read as Hermes does (utf-8-sig JSON object), so it is never rewritten without the user's approvals. */
function readAllowlist(path: string): Allowlist {
  if (!existsSync(path)) return { approvals: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Allowlist;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${ALLOWLIST} is not a JSON object`);
  return Array.isArray(raw.approvals) ? raw : { ...raw, approvals: [] };
}

const approves = (e: Record<string, unknown>, command: string) => e.event === EVENT && e.command === command;

/**
 * Read-modify-write the allowlist under Hermes's own lock: an exclusive
 * flock(2) on the sibling `shell-hooks-allowlist.json.lock` (Hermes's
 * agent/shell_hooks.py `_locked_update_approvals`), so an approval Hermes
 * records at the same moment is never lost. Fails closed: a lock held past
 * the wait, or no lock primitive on this host, throws and writes nothing.
 */
function withAllowlistLock(path: string, update: (list: Allowlist) => Allowlist | null): void {
  const lockPath = `${path}.lock`;
  const lock = acquireNativeLockSync(lockPath, { timeoutMs: 3000 });
  if (!lock) throw new Error(`Hermes holds ${lockPath}; ${ALLOWLIST} was not changed. Run setup again once Hermes is idle`);
  try {
    const next = update(readAllowlist(path));
    if (next) atomicWriteTextFile(path, `${JSON.stringify(next, null, 2)}\n`, { freshMode: 0o600 });
  } finally {
    lock.release();
  }
}

function approve(hermesHome: string, command: string): void {
  withAllowlistLock(join(hermesHome, ALLOWLIST), (list) => {
    if (list.approvals.some((e) => approves(e, command))) return null;
    list.approvals.push({ event: EVENT, command, approved_at: new Date().toISOString(), script_mtime_at_approval: null });
    return list;
  });
}

function revoke(hermesHome: string, command: string): void {
  const path = join(hermesHome, ALLOWLIST);
  if (!existsSync(path)) return;
  withAllowlistLock(path, (list) => {
    const kept = list.approvals.filter((e) => !approves(e, command));
    return kept.length === list.approvals.length ? null : { ...list, approvals: kept };
  });
}

/** Write or update the hook (accepted decision). Never throws: anything gbrain cannot edit safely is printed to add by hand. */
export function syncHermesTurnHook(opts: { hermesHome: string; access: BrainFirstAccess; dryRun: boolean }): HermesTurnHookOutcome {
  const path = join(opts.hermesHome, 'config.yaml');
  const command = hermesTurnHookCommand(opts.access);
  const print = (why: string): HermesTurnHookOutcome => ({ action: 'print', path, detail: `${why}; add this to ${path} and approve it when Hermes asks (non-interactive runs: HERMES_ACCEPT_HOOKS=1)`, snippet: hookYaml(command) });
  if (!existsSync(opts.hermesHome)) return print(`${opts.hermesHome} does not exist yet`);
  try {
    const missing = !existsSync(path);
    const text = missing ? '' : readFileSync(path, 'utf8');
    const probe = probeBlock(MARKERS, text);
    if (probe.state === 'damaged') return print('the gbrain turn-rule markers in config.yaml are damaged');
    if (probe.state === 'absent') {
      const doc = loadBoundedYaml(text) as Record<string, unknown> | null | undefined;
      if (doc !== null && doc !== undefined && typeof doc !== 'object') return print('config.yaml is not a YAML mapping');
      if (doc && 'hooks' in doc) return print('config.yaml already has a hooks: section, which gbrain does not edit');
    }
    readAllowlist(join(opts.hermesHome, ALLOWLIST));
    const next = spliceBlock(MARKERS, text, hookYaml(command));
    if (probe.state === 'absent' && !(loadBoundedYaml(next) as Record<string, unknown> | null)?.hooks) return print('config.yaml would not parse with the hook appended');
    if (next === text) {
      if (!opts.dryRun) approve(opts.hermesHome, command);
      return { action: 'keep', path, detail: `per-turn rule hook (${EVENT}) in ${path}` };
    }
    if (!opts.dryRun) {
      writeUnlessChanged(path, text, missing, next);
      const previous = commandIn(probe.interior);
      if (previous && previous !== command) revoke(opts.hermesHome, previous);
      approve(opts.hermesHome, command);
    }
    return { action: 'write', path, detail: `per-turn rule hook (${EVENT}) in ${path}, approved in ${ALLOWLIST}` };
  } catch (e) {
    return print(`config.yaml could not be updated (${(e as Error).message})`);
  }
}

/** Strip the hook and its approval (decline or --remove). Never throws. */
export function removeHermesTurnHook(opts: { hermesHome: string; dryRun: boolean }): HermesTurnHookOutcome {
  const path = join(opts.hermesHome, 'config.yaml');
  try {
    if (!existsSync(path)) return { action: 'skip', path, detail: `no per-turn rule hook in ${path}` };
    const text = readFileSync(path, 'utf8');
    const probe = probeBlock(MARKERS, text);
    if (probe.state !== 'present') return { action: 'skip', path, detail: `no per-turn rule hook in ${path}` };
    const command = commandIn(probe.interior);
    if (!opts.dryRun) {
      writeUnlessChanged(path, text, false, removeBlock(MARKERS, text).text);
      if (command) revoke(opts.hermesHome, command);
    }
    return { action: 'remove', path, detail: `per-turn rule hook removed from ${path}` };
  } catch (e) {
    return { action: 'skip', path, detail: `per-turn rule hook in ${path} left as it is (${(e as Error).message})` };
  }
}

/** Read-only: is the marked hook in config.yaml, and does Hermes's allowlist approve its exact command? */
export function inspectHermesTurnHook(hermesHome: string): { state: 'absent' | 'unapproved' | 'approved'; path: string; command?: string } {
  const path = join(hermesHome, 'config.yaml');
  try {
    const probe = probeBlock(MARKERS, existsSync(path) ? readFileSync(path, 'utf8') : '');
    const command = probe.state === 'present' ? commandIn(probe.interior) : null;
    if (!command) return { state: 'absent', path };
    return { state: readAllowlist(join(hermesHome, ALLOWLIST)).approvals.some((e) => approves(e, command)) ? 'approved' : 'unapproved', path, command };
  } catch {
    return { state: 'absent', path };
  }
}
