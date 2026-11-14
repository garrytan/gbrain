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
 *
 * The same block also carries the skill-resolver lane's entry
 * (`gbrain setup hermes --skill-loading resolve`, skill-resolver-hook.ts):
 * config.yaml can hold one top-level `hooks:` key, so both lanes share one
 * marked block, each entry with its own approval. Each lane writes and removes
 * only its own entry, so declining the brain-first rule keeps the resolver
 * and the reverse; the block goes when its last entry does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { acquireNativeLockSync } from '../persistence/native-lock.ts';
import { loadBoundedYaml } from '../data-frontmatter.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { renderBrainFirstTurnRule, writeUnlessChanged, type BrainFirstAccess } from './brain-first.ts';
import { isSkillResolverCommand } from './skill-resolver-lane.ts';

const MARKERS: BlockMarkers = { begin: '# gbrain:turn-rule:begin', end: '# gbrain:turn-rule:end', label: 'turn-rule', rerun: 'gbrain setup hermes --instructions-only' };
const EVENT = 'pre_llm_call';
const ALLOWLIST = 'shell-hooks-allowlist.json';

export interface HermesTurnHookOutcome { action: 'write' | 'keep' | 'print' | 'remove' | 'skip'; path: string; detail: string; snippet?: string }

/** `/bin/echo '<json>'`: Hermes splits the command without a shell (and checks the first path, /bin/echo, exists), and a quote in the rule is a JSON escape. */
export function hermesTurnHookCommand(access: BrainFirstAccess): string {
  return `/bin/echo '${JSON.stringify({ context: renderBrainFirstTurnRule(access, 'hermes') }).replace(/'/g, '\\u0027')}'`;
}

/** The lanes that own an entry in gbrain's block, in the order the block lists them, with each entry's timeout. */
export type HermesHookLane = 'turn-rule' | 'skill-resolver';
const LANES: Record<HermesHookLane, { timeout: number; what: string }> = {
  'turn-rule': { timeout: 10, what: 'per-turn rule hook' },
  'skill-resolver': { timeout: 15, what: 'skill-resolver lane hook' },
};
const laneOf = (command: string): HermesHookLane => (isSkillResolverCommand(command) ? 'skill-resolver' : 'turn-rule');

/** Each lane's command in the block (the first entry of each lane). */
function entriesIn(interior: string | undefined): Partial<Record<HermesHookLane, string>> {
  const out: Partial<Record<HermesHookLane, string>> = {};
  for (const m of (interior ?? '').matchAll(/command: (".*")/g)) {
    const command = JSON.parse(m[1]!) as string;
    out[laneOf(command)] ??= command;
  }
  return out;
}

const commandIn = (interior: string | undefined): string | null => entriesIn(interior)['turn-rule'] ?? null;

function hooksYaml(entries: Partial<Record<HermesHookLane, string>>): string {
  const items = (Object.keys(LANES) as HermesHookLane[]).flatMap((lane) => (entries[lane] ? [`    - command: ${JSON.stringify(entries[lane])}\n      timeout: ${LANES[lane].timeout}\n`] : []));
  return `hooks:\n  ${EVENT}:\n${items.join('')}`;
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
  return syncHermesHook({ hermesHome: opts.hermesHome, lane: 'turn-rule', command: hermesTurnHookCommand(opts.access), dryRun: opts.dryRun });
}

/** A `pre_llm_call` entry with exactly this command in config.yaml outside gbrain's block (pasted by hand from a printed snippet). */
function pastedIn(doc: Record<string, unknown> | null | undefined, command: string): boolean {
  const entries = (doc?.hooks as Record<string, unknown> | undefined)?.[EVENT];
  return Array.isArray(entries) && entries.some((e) => (e as { command?: unknown } | null)?.command === command);
}

/**
 * Write or update one lane's entry in gbrain's block, keeping the other
 * lane's. Never throws: anything gbrain cannot edit safely is printed to add
 * by hand. The resolver's entry pasted by hand under the user's own `hooks:`
 * (the printed snippet) is kept and approved.
 */
export function syncHermesHook(opts: { hermesHome: string; lane: HermesHookLane; command: string; dryRun: boolean }): HermesTurnHookOutcome {
  const path = join(opts.hermesHome, 'config.yaml');
  const { command, lane } = opts;
  const what = LANES[lane].what;
  const print = (why: string): HermesTurnHookOutcome => ({ action: 'print', path, detail: `${why}; add this to ${path} and approve it when Hermes asks (non-interactive runs: HERMES_ACCEPT_HOOKS=1)`, snippet: hooksYaml({ [lane]: command }) });
  if (!existsSync(opts.hermesHome)) return print(`${opts.hermesHome} does not exist yet`);
  try {
    const missing = !existsSync(path);
    const text = missing ? '' : readFileSync(path, 'utf8');
    const probe = probeBlock(MARKERS, text);
    if (probe.state === 'damaged') return print('the gbrain turn-rule markers in config.yaml are damaged');
    if (probe.state === 'absent') {
      const doc = loadBoundedYaml(text) as Record<string, unknown> | null | undefined;
      if (doc !== null && doc !== undefined && typeof doc !== 'object') return print('config.yaml is not a YAML mapping');
      if (doc && lane === 'skill-resolver' && pastedIn(doc as Record<string, unknown>, command)) {
        readAllowlist(join(opts.hermesHome, ALLOWLIST));
        if (!opts.dryRun) approve(opts.hermesHome, command);
        return { action: 'keep', path, detail: `${what} (${EVENT}) in ${path}, added by hand` };
      }
      if (doc && 'hooks' in doc) return print('config.yaml already has a hooks: section, which gbrain does not edit');
    }
    readAllowlist(join(opts.hermesHome, ALLOWLIST));
    const entries = entriesIn(probe.interior);
    const next = spliceBlock(MARKERS, text, hooksYaml({ ...entries, [lane]: command }));
    if (probe.state === 'absent' && !(loadBoundedYaml(next) as Record<string, unknown> | null)?.hooks) return print('config.yaml would not parse with the hook appended');
    if (next === text) {
      if (!opts.dryRun) approve(opts.hermesHome, command);
      return { action: 'keep', path, detail: `${what} (${EVENT}) in ${path}` };
    }
    if (!opts.dryRun) {
      writeUnlessChanged(path, text, missing, next);
      const previous = entries[lane];
      if (previous && previous !== command) revoke(opts.hermesHome, previous);
      approve(opts.hermesHome, command);
    }
    return { action: 'write', path, detail: `${what} (${EVENT}) in ${path}, approved in ${ALLOWLIST}` };
  } catch (e) {
    return print(`config.yaml could not be updated (${(e as Error).message})`);
  }
}

/** Strip the hook and its approval (decline or --remove). Never throws. */
export function removeHermesTurnHook(opts: { hermesHome: string; dryRun: boolean }): HermesTurnHookOutcome {
  return removeHermesHook({ ...opts, lane: 'turn-rule' });
}

/** Strip one lane's entry and its approval, keeping the other lane's; the block goes with its last entry. Never throws. */
export function removeHermesHook(opts: { hermesHome: string; lane: HermesHookLane; dryRun: boolean }): HermesTurnHookOutcome {
  const path = join(opts.hermesHome, 'config.yaml');
  const what = LANES[opts.lane].what;
  try {
    if (!existsSync(path)) return { action: 'skip', path, detail: `no ${what} in ${path}` };
    const text = readFileSync(path, 'utf8');
    const probe = probeBlock(MARKERS, text);
    const entries = probe.state === 'present' ? entriesIn(probe.interior) : {};
    const command = entries[opts.lane];
    const pasted = probe.state === 'absent' && opts.lane === 'skill-resolver' ? inspectHermesResolverHook(opts.hermesHome).command : undefined;
    if (pasted) {
      if (!opts.dryRun) revoke(opts.hermesHome, pasted);
      return { action: 'skip', path, detail: `the ${what} you pasted under your own hooks: in ${path} is not gbrain's to edit, so delete it there; its approval in ${ALLOWLIST} is withdrawn` };
    }
    if (probe.state !== 'present' || (!command && (opts.lane === 'skill-resolver' || Object.keys(entries).length > 0))) return { action: 'skip', path, detail: `no ${what} in ${path}` };
    const rest = { ...entries, [opts.lane]: undefined };
    const left = Object.values(rest).some(Boolean);
    if (!opts.dryRun) {
      writeUnlessChanged(path, text, false, left ? spliceBlock(MARKERS, text, hooksYaml(rest)) : removeBlock(MARKERS, text).text);
      if (command) revoke(opts.hermesHome, command);
    }
    return { action: 'remove', path, detail: `${what} removed from ${path}` };
  } catch (e) {
    return { action: 'skip', path, detail: `${what} in ${path} left as it is (${(e as Error).message})` };
  }
}

/** Read-only: is the skill-resolver lane's entry in config.yaml (gbrain's block, else pasted by hand), and does Hermes's allowlist approve it? */
export function inspectHermesResolverHook(hermesHome: string): { state: 'absent' | 'unapproved' | 'approved'; path: string; command?: string } {
  const path = join(hermesHome, 'config.yaml');
  try {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const probe = probeBlock(MARKERS, text);
    const doc = probe.state === 'absent' ? loadBoundedYaml(text) as Record<string, unknown> | null | undefined : null;
    const pasted = doc && typeof doc === 'object' ? ((doc.hooks as Record<string, unknown> | undefined)?.[EVENT] as Array<{ command?: unknown }> | undefined) : undefined;
    const command = probe.state === 'present' ? entriesIn(probe.interior)['skill-resolver']
      : Array.isArray(pasted) ? pasted.map((e) => e?.command).find((c): c is string => typeof c === 'string' && isSkillResolverCommand(c)) : undefined;
    if (!command) return { state: 'absent', path };
    return { state: readAllowlist(join(hermesHome, ALLOWLIST)).approvals.some((e) => approves(e, command)) ? 'approved' : 'unapproved', path, command };
  } catch {
    return { state: 'absent', path };
  }
}

/** Read-only: is the marked hook in config.yaml (or, without one, the exact entry setup printed for `access`, added by hand to the user's hooks: section), and does Hermes's allowlist approve its exact command? */
export function inspectHermesTurnHook(hermesHome: string, access?: BrainFirstAccess): { state: 'absent' | 'unapproved' | 'approved'; path: string; command?: string } {
  const path = join(hermesHome, 'config.yaml');
  try {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const probe = probeBlock(MARKERS, text);
    const printed = access && probe.state === 'absent' ? hermesTurnHookCommand(access) : null;
    const pasted = printed ? (loadBoundedYaml(text) as { hooks?: Record<string, unknown> } | null)?.hooks?.[EVENT] : undefined;
    const command = probe.state === 'present' ? commandIn(probe.interior)
      : Array.isArray(pasted) && pasted.some((e) => (e as { command?: unknown } | null)?.command === printed) ? printed : null;
    if (!command) return { state: 'absent', path };
    return { state: readAllowlist(join(hermesHome, ALLOWLIST)).approvals.some((e) => approves(e, command)) ? 'approved' : 'unapproved', path, command };
  } catch {
    return { state: 'absent', path };
  }
}
