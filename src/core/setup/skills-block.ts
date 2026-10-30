/**
 * setup/skills-block.ts — the managed `gbrain:skills` block: the always-loaded
 * half of the spring-loaded skill resolver, written beside the brain-first
 * block (brain-first.ts) in the same harness instruction file.
 *
 * Selectable: `--skill-loading spring` (or GBRAIN_SKILL_LOADING=spring) writes
 * it; `off`, the default, writes nothing and strips a block an earlier run
 * wrote. `--no-instructions` strips it with the brain-first block. The block
 * is a compact index of gbrain's bundled skills plus one sentence on loading a
 * skill on demand with `<launcher> bundled-skill <name>` (spring-index.ts);
 * the skill bodies stay out of the context until a task matches. The launcher
 * is the same absolute gbrain the install registered, so the index and the
 * text it loads come from one binary, whatever MCP server or brain the
 * harness is connected to.
 *
 * Ownership is by markers (managed-block.ts): the interior is gbrain's, text
 * outside the markers is never touched. Decisions live in their own ledger,
 * <configDir>/skill-loading.json, keyed on (harness, path), so brain-first's
 * ledger stays as it is. created_file is true when gbrain created the file,
 * through either block, so whichever block is removed last deletes a file
 * nothing else was written into.
 */
import { accessSync, constants as fsConstants, existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { resolveGbrainBin } from '../gbrain-bin.ts';
import { addPermissionsAllowEntry, removePermissionsAllowEntry } from '../bootstrap/hooks.ts';
import { claudeUserSettingsPath } from '../bootstrap/host-specs.ts';
import { spawnSync } from '../spawn.ts';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { configDir } from '../config.ts';
import { probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';
import { ensureGitExcluded } from '../context/compiled-core.ts';
import { bundledCatalogId, bundledSkills, type SkillAudience } from '../skills/bundled.ts';
import { shellQuote } from '../shell-quote.ts';
import { renderSkillIndexBlock, SKILL_INDEX_VERSION, SkillIndexTooLarge, skillIndexCatalog } from '../skills/spring-index.ts';
import { SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END } from '../skills/index-block.ts';
import { BRAIN_FIRST_END, brainFirstTargetAt, CURSOR_HEAD, direntExists, readBrainFirstLedger, writeUnlessChanged, type BrainFirstHarness, type BrainFirstTarget } from './brain-first.ts';

export { SKILLS_BLOCK_BEGIN, SKILLS_BLOCK_END };
export const SKILL_LOADING_ENV = 'GBRAIN_SKILL_LOADING';
export const SKILL_LOADING_MODES = ['off', 'spring'] as const;
export type SkillLoading = (typeof SKILL_LOADING_MODES)[number];
const MARKERS: BlockMarkers = { begin: SKILLS_BLOCK_BEGIN, end: SKILLS_BLOCK_END, label: 'skills', rerun: 'gbrain setup <harness> --skills-index-only' };
const LEDGER_FILE = 'skill-loading.json';

export function isSkillLoading(v: unknown): v is SkillLoading {
  return (SKILL_LOADING_MODES as readonly unknown[]).includes(v);
}

/**
 * The command that refreshes every index recorded for a harness after an
 * upgrade: it rewrites only the skills block, at the recorded file, with the
 * recorded launcher and audience, and never touches brain-first.
 */
export function skillsRefreshCommand(harness: string): string {
  return `gbrain setup ${harness} --skills-index-only`;
}

/** The absolute gbrain an index should name when no --gbrain-bin is given: this compiled binary, else the one on PATH. */
export function indexLauncher(): string | null {
  if (basename(process.execPath).startsWith('gbrain')) return process.execPath;
  return resolveGbrainBin();
}

/**
 * The catalog identity the launcher actually serves (`<launcher> bundled-skill
 * --json`), so an index is never written naming a gbrain whose skills differ
 * from the ones indexed (another install earlier on PATH, a stale
 * --gbrain-bin). Engine-free and read-only on the launcher's side.
 */
const servedCatalogs = new Map<string, { catalog: string } | { error: string }>();

export function launcherCatalog(launcher: string): { catalog: string } | { error: string } {
  if (!isAbsolute(launcher)) return { error: `${launcher} is not an absolute path (GUI-launched harnesses inherit no PATH)` };
  const known = servedCatalogs.get(launcher);
  if (known) return known;
  const served = askLauncher(launcher);
  servedCatalogs.set(launcher, served);
  return served;
}

function askLauncher(launcher: string): { catalog: string } | { error: string } {
  const r = spawnSync(launcher, ['bundled-skill', '--json'], { encoding: 'utf8', timeout: 20_000 }) as { status: number | null; stdout?: string; stderr?: string; error?: Error };
  if (r.status !== 0) return { error: `${launcher} bundled-skill --json failed: ${(r.error?.message ?? r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}`}` };
  try {
    const catalog = (JSON.parse(r.stdout ?? '') as { catalog?: unknown }).catalog;
    return typeof catalog === 'string' ? { catalog } : { error: `${launcher} reported no skill catalog (a gbrain without bundled-skill)` };
  } catch {
    return { error: `${launcher} bundled-skill --json printed no JSON` };
  }
}

/**
 * The block interior for a harness. `owner` (an install on the brain host)
 * indexes every bundled skill; `downstream` (a thin client) leaves out the
 * host-only ones, as `gbrain bundled-skill` does there. Throws
 * SkillIndexTooLarge rather than return a block over budget.
 */
export function renderSkillsBlock(harness: string, launcher: string, audience: SkillAudience = 'owner', how?: { refresh: string; optOut: string }): string {
  return renderSkillIndexBlock(bundledSkills(audience), launcher, how ?? { refresh: skillsRefreshCommand(harness), optOut: `${skillsRefreshCommand(harness)} --skill-loading off` });
}

/** The block with its markers, for a file gbrain writes whole (the thin-client GBRAIN-INSTRUCTIONS.md). */
export function renderSkillsSnippet(harness: string, launcher: string, audience: SkillAudience, how: { refresh: string; optOut: string }): string {
  return `${SKILLS_BLOCK_BEGIN}\n${renderSkillsBlock(harness, launcher, audience, how)}\n${SKILLS_BLOCK_END}\n`;
}

// ── Ledger ────────────────────────────────────────────────────────────────

export interface SkillLoadingLedgerEntry {
  harness: string;
  path: string;
  mode: SkillLoading;
  block_version: number;
  /** The catalog the written block indexes (bundledCatalogId). */
  catalog?: string;
  launcher?: string;
  audience?: SkillAudience;
  /** Claude Code: the permissions.allow rule that lets sessions run the loader, the settings file it is in, and whether gbrain added it. */
  allow_rule?: string;
  allow_settings?: string;
  allow_owned?: boolean;
  /** The user removed the rule gbrain added; it is not added again until an explicit --skill-loading spring. */
  allow_declined?: boolean;
  writer: string;
  created_file: boolean;
  updated_at: string;
}

export function skillLoadingLedgerPath(): string { return join(configDir(), LEDGER_FILE); }

/** A ledger gbrain cannot read: ownership is unknown, so nothing that depends on it is changed. */
export class SkillLedgerUnreadable extends Error {
  constructor(readonly path: string, why: string, raw = '') {
    const newer = /"version"\s*:\s*(\d+)/.exec(raw);
    const rules = [...new Set([...raw.matchAll(/"allow_rule"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1')))];
    const rulesNote = rules.length ? ` and the Claude Code permission rule${rules.length > 1 ? 's' : ''} it names (${rules.join(', ')}, normally in ${claudeUserSettingsPath()})` : '';
    super(newer && Number(newer[1]) > 1
      ? `${path} was written by a newer gbrain (ledger version ${newer[1]}); upgrade gbrain, then re-run`
      : `${path} is unreadable (${why}); ownership is unknown, so no skills index or permission rule was changed. Restore a valid copy or fix that entry, then re-run once. Starting over without it would leave whatever it recorded behind: if you must, first remove the gbrain:skills blocks${rulesNote} by hand`);
  }
}

/** The recorded choices; [] when there is no ledger. Throws SkillLedgerUnreadable for a file it cannot parse. */
export function readSkillLoadingLedger(): SkillLoadingLedgerEntry[] {
  const path = skillLoadingLedgerPath();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  let raw: { version?: unknown; entries?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch (e) {
    throw new SkillLedgerUnreadable(path, e instanceof Error ? e.message : String(e), text);
  }
  if (raw?.version !== 1 || !Array.isArray(raw.entries)) throw new SkillLedgerUnreadable(path, 'not a version-1 ledger', text);
  const entries = raw.entries as SkillLoadingLedgerEntry[];
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const bad = invalidLedgerField(e);
    if (bad) throw new SkillLedgerUnreadable(path, `entry ${i} has an invalid ${bad}`, text);
    const key = JSON.stringify([e.harness, e.path]);
    if (seen.has(key)) throw new SkillLedgerUnreadable(path, `entry ${i} repeats ${e.harness} ${e.path}`, text);
    seen.add(key);
  });
  return entries;
}

/** The first field of a ledger entry that is missing or of the wrong type, else undefined. */
function invalidLedgerField(e: SkillLoadingLedgerEntry): string | undefined {
  if (!e || typeof e !== 'object') return 'entry';
  const optional = (v: unknown, type: string) => v !== undefined && typeof v !== type;
  if (typeof e.harness !== 'string') return 'harness';
  if (typeof e.path !== 'string') return 'path';
  if (!isSkillLoading(e.mode)) return 'mode';
  if (typeof e.writer !== 'string') return 'writer';
  if (typeof e.created_file !== 'boolean') return 'created_file';
  if (e.audience !== undefined && e.audience !== 'owner' && e.audience !== 'downstream') return 'audience';
  for (const k of ['catalog', 'launcher', 'allow_rule', 'allow_settings'] as const) if (optional(e[k], 'string')) return k;
  for (const k of ['allow_owned', 'allow_declined'] as const) if (optional(e[k], 'boolean')) return k;
  if ((e.allow_owned === true || e.allow_declined === true) && e.allow_rule === undefined) return 'allow_rule (ownership recorded without the rule)';
  if (e.allow_owned === true && e.allow_declined === true) return 'allow_declined (both owned and declined)';
  return undefined;
}

function writeLedger(entries: SkillLoadingLedgerEntry[]): void {
  atomicWriteTextFile(skillLoadingLedgerPath(), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { freshMode: 0o600 });
}

function upsertLedger(entry: SkillLoadingLedgerEntry): void {
  writeLedger([...readSkillLoadingLedger().filter((e) => !(e.harness === entry.harness && e.path === entry.path)), entry]);
}

function dropLedger(harness: string, path: string): void {
  const all = readSkillLoadingLedger();
  const rest = all.filter((e) => !(e.harness === harness && e.path === path));
  if (rest.length !== all.length) writeLedger(rest);
}

export function priorSkillLoading(harness: string, path: string): SkillLoadingLedgerEntry | undefined {
  return readSkillLoadingLedger().find((e) => e.harness === harness && e.path === path);
}

// ── Loader permission (Claude Code) ───────────────────────────────────────

/**
 * Claude Code asks before every Bash call it has no rule for, and headless
 * runs deny it, so a spring index on Claude Code comes with one narrow rule
 * in the user settings: the recorded launcher's `bundled-skill` subcommand
 * only, written exactly as the index writes the command. Ownership lives in
 * the ledger (allow_owned): every index that uses a rule gbrain added shares
 * that ownership, and gbrain removes the rule only when the last of them goes.
 */
export function loaderAllowRule(launcher: string): string {
  return `Bash(${shellQuote(launcher)} bundled-skill:*)`;
}

type Grant = Pick<SkillLoadingLedgerEntry, 'allow_rule' | 'allow_settings' | 'allow_owned' | 'allow_declined'>;

const ruleSettings = (e: Grant) => e.allow_settings ?? claudeUserSettingsPath();

/** Whether the settings file lists the rule; undefined when the file cannot be read as JSON. */
function loaderRulePresent(settings: string, rule: string): boolean | undefined {
  if (!existsSync(settings)) return false;
  try {
    const allow = (JSON.parse(readFileSync(settings, 'utf8')) as { permissions?: { allow?: unknown } })?.permissions?.allow;
    return Array.isArray(allow) && allow.includes(rule);
  } catch {
    return undefined;
  }
}

/** The recorded rule is this one and the user took it out since (whoever added it), or declined it before. */
function userRemovedRule(prior: SkillLoadingLedgerEntry | undefined, rule: string, settings: string): boolean {
  if (prior?.allow_rule !== rule || ruleSettings(prior) !== settings || !existsSync(settings)) return false;
  const present = loaderRulePresent(settings, rule);
  if (present !== false) return false;
  return true;
}

/**
 * Add the rule after the block is in place; returns the ownership to record,
 * whether this call added it, and whether it stayed out because the user
 * removed the rule gbrain added (only an explicit --skill-loading spring adds
 * it back). Throws when settings cannot be updated.
 */
function grantLoader(harness: string, launcher: string, settings: string, prior: SkillLoadingLedgerEntry | undefined, regrant: boolean): { grant: Grant; added: boolean; declined: boolean } {
  if (harness !== 'claude-code') return { grant: {}, added: false, declined: false };
  const rule = loaderAllowRule(launcher);
  if (userRemovedRule(prior, rule, settings) && !regrant) return { grant: { allow_rule: rule, allow_settings: settings, allow_owned: false, allow_declined: true }, added: false, declined: true };
  const added = addPermissionsAllowEntry(settings, rule).added === true;
  const shared = readSkillLoadingLedger().some((e) => e.allow_rule === rule && ruleSettings(e) === settings && e.allow_owned === true);
  return { grant: { allow_rule: rule, allow_settings: settings, allow_owned: added || shared }, added, declined: false };
}

/** The owned rule revokeLoader would take out for this entry, or undefined when it has none to take or another index still uses it. Throws on an unreadable ledger. */
function revocableRule(entry: SkillLoadingLedgerEntry | undefined, keep?: { rule?: string; settings: string }): { rule: string; settings: string } | undefined {
  if (!entry?.allow_rule || entry.allow_owned !== true) return undefined;
  const rule = entry.allow_rule;
  const settings = ruleSettings(entry);
  if (keep && rule === keep.rule && settings === keep.settings) return undefined;
  const stillOwned = readSkillLoadingLedger().some((e) => e.mode === 'spring' && e.allow_owned === true && e.allow_rule === rule && ruleSettings(e) === settings && !(e.harness === entry.harness && e.path === entry.path));
  return stillOwned ? undefined : { rule, settings };
}

/** What --dry-run reports for the loader rule: the change a real run would make. */
function plannedPermission(change: 'would_add' | 'would_remove', target: { rule: string; settings: string } | undefined): Partial<SkillsBlockOutcome> {
  if (!target || loaderRulePresent(target.settings, target.rule) === (change === 'would_add')) return {};
  return { permission: { ...target, change } };
}

/**
 * Remove a rule gbrain owns once no other recorded index uses it. Never
 * throws: `problem` says why the rule is still there, `removed` names the
 * rule when this call took it out of the settings.
 */
function revokeLoader(entry: SkillLoadingLedgerEntry | undefined, keep?: { rule?: string; settings: string }): { removed?: { rule: string; settings: string }; problem?: string } {
  if (!entry?.allow_rule || entry.allow_owned !== true) return {};
  const rule = entry.allow_rule;
  const settings = ruleSettings(entry);
  const stuck = (why: string) => ({ problem: `the Claude Code permission rule ${rule} that gbrain added is still in ${settings}: ${why}` });
  try {
    if (!revocableRule(entry, keep)) return {};
    const r = removePermissionsAllowEntry(settings, rule);
    const warning = r.notes.find((n) => n.startsWith('WARNING'));
    if (warning) return stuck(warning);
    return (r.removed ?? 0) > 0 ? { removed: { rule, settings } } : {};
  } catch (e) {
    return stuck(message(e));
  }
}

// ── Decision, inspection, sync, removal ───────────────────────────────────

/** unresolved: the choice could not be read (an unreadable ledger, an invalid GBRAIN_SKILL_LOADING). */
export type SkillLoadingSource = 'flag' | 'env' | 'prior' | 'default' | 'instructions_off' | 'unresolved';
export interface SkillLoadingDecision { value: SkillLoading; source: SkillLoadingSource }

/** GBRAIN_SKILL_LOADING holds something other than off or spring. */
export class InvalidSkillLoadingEnv extends Error {
  constructor(readonly value: string) {
    super(`${SKILL_LOADING_ENV}='${value}' is not a skill-loading mode; set it to off or spring, or unset it`);
  }
}

/** --skill-loading wins, then GBRAIN_SKILL_LOADING, then the recorded choice, then off. An invalid env value throws. */
export function resolveSkillLoading(flag: SkillLoading | undefined, prior: Pick<SkillLoadingLedgerEntry, 'mode'> | undefined): SkillLoadingDecision {
  if (flag !== undefined) return { value: flag, source: 'flag' };
  const env = process.env[SKILL_LOADING_ENV]?.trim();
  if (env) {
    if (!isSkillLoading(env)) throw new InvalidSkillLoadingEnv(env);
    return { value: env, source: 'env' };
  }
  if (prior) return { value: prior.mode, source: 'prior' };
  return { value: 'off', source: 'default' };
}

export type SkillsBlockState = 'no_file' | 'absent' | 'current' | 'stale' | 'damaged';

/**
 * The block's state. With `expected` (the interior this run would write),
 * current means identical; without it, current means the block indexes this
 * gbrain's catalog (same index version and catalog identity).
 */
export function inspectSkillsBlock(path: string, expected?: string): { state: SkillsBlockState; version?: number; catalog?: string } {
  if (!existsSync(path)) return { state: 'no_file' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { state: 'damaged' };
  }
  const probe = probeBlock(MARKERS, text);
  if (probe.state !== 'present') return { state: probe.state };
  const interior = probe.interior ?? '';
  const version = Number(/gbrain skills v(\d+)/.exec(interior)?.[1] ?? 0);
  const catalog = skillIndexCatalog(interior);
  const current = expected !== undefined ? interior === expected : version === SKILL_INDEX_VERSION && catalog === bundledCatalogId();
  return { state: current ? 'current' : 'stale', version, ...(catalog ? { catalog } : {}) };
}

/** Why an outcome is `preserve` (or a skip that needs the user), stable for JSON consumers. */
export type SkillsBlockReason = 'damaged_markers' | 'index_too_large' | 'launcher_unusable' | 'launcher_catalog_mismatch'
  | 'ledger_unreadable' | 'invalid_env' | 'permission_update_failed' | 'write_failed' | 'recorded_partially' | 'hermes_soul_missing';

export interface SkillsBlockOutcome {
  harness: string;
  path: string;
  decision: SkillLoadingDecision;
  action: 'write' | 'keep' | 'remove' | 'skip' | 'preserve';
  state_before: SkillsBlockState;
  detail: string;
  reason?: SkillsBlockReason;
  /** Claude Code: the loader rule this run added to (or removed from) the user settings. */
  permission?: { rule: string; settings: string; change: 'added' | 'removed' | 'would_add' | 'would_remove' };
  /** Claude Code: the previous launcher's rule a launcher change took out (or would). */
  replaced_permission?: { rule: string; settings: string; change: 'removed' | 'would_remove' };
}

/**
 * The install did not do what was asked: a spring request (or an explicit
 * off) left the surface unchanged, or an explicit spring was skipped for a
 * reason the user has to fix (Hermes without SOUL.md).
 */
export const skillsOutcomeFailed = (o: SkillsBlockOutcome | null | undefined): boolean => {
  if (!o) return false;
  if (o.action === 'preserve') return o.decision.value === 'spring' || o.decision.source !== 'default';
  return o.action === 'skip' && o.reason !== undefined && o.decision.value === 'spring' && (o.decision.source === 'flag' || o.decision.source === 'env');
};

function ownedEmptyFile(createdFile: boolean, path: string, stripped: string): boolean {
  return createdFile && !lstatSync(path).isSymbolicLink() && (stripped.trim() === '' || stripped === CURSOR_HEAD);
}

/** Splice the block in place; a new block goes right after the brain-first block when there is one, else at the end. */
export function placeSkillsBlock(existing: string, body: string): string {
  if (probeBlock(MARKERS, existing).state === 'present') return spliceBlock(MARKERS, existing, body);
  const lines = existing.split('\n');
  const at = lines.findIndex((l) => l.replace(/\r$/, '') === BRAIN_FIRST_END);
  if (at < 0) return spliceBlock(MARKERS, existing, body);
  const block = spliceBlock(MARKERS, '', body).replace(/\n$/, '').split('\n');
  return [...lines.slice(0, at + 1), ...block, ...lines.slice(at + 1)].join('\n');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Make the surface match the decision: write or refresh the block for
 * `spring`, strip it for `off`. Never throws: every refusal is a `preserve`
 * outcome with a reason, and the file is left as it was unless the detail
 * says otherwise.
 */
export function syncSkillsBlock(opts: { target: BrainFirstTarget; launcher: string; decision: SkillLoadingDecision; writer: string; dryRun: boolean; audience?: SkillAudience; settingsPath?: string }): SkillsBlockOutcome {
  const { target, launcher, decision } = opts;
  const settings = opts.settingsPath ?? claudeUserSettingsPath();
  const audience = opts.audience ?? 'owner';
  let body: string | undefined;
  let tooLarge: SkillIndexTooLarge | undefined;
  try {
    body = renderSkillsBlock(target.harness, launcher, audience);
  } catch (e) {
    if (!(e instanceof SkillIndexTooLarge)) throw e;
    tooLarge = e;
  }
  const before = inspectSkillsBlock(target.path, body);
  const out = (action: SkillsBlockOutcome['action'], detail: string, extra: Partial<SkillsBlockOutcome> = {}): SkillsBlockOutcome =>
    ({ harness: target.harness, path: target.path, decision, action, state_before: before.state, detail, ...extra });
  let prior: SkillLoadingLedgerEntry | undefined;
  try {
    prior = priorSkillLoading(target.harness, target.path);
  } catch (e) {
    return out('preserve', `${message(e)}; ${target.path} was left as it was`, { reason: 'ledger_unreadable' });
  }
  const record = (mode: SkillLoading, created: boolean, grant: Grant = {}) => {
    if (opts.dryRun) return;
    if (mode === 'off' && decision.source === 'default' && !prior) return;
    upsertLedger({ harness: target.harness, path: target.path, mode, block_version: SKILL_INDEX_VERSION, ...(mode === 'spring' ? { catalog: bundledCatalogId(), launcher, audience, ...grant } : {}), writer: opts.writer, created_file: created, updated_at: new Date().toISOString() });
  };

  if (before.state === 'damaged') {
    return out('preserve', `the skills markers in ${target.path} were hand-edited (duplicate, orphan or out of order); fix or delete them, then re-run`, { reason: 'damaged_markers' });
  }
  if (decision.value === 'off') {
    if (decision.source === 'default' && !prior && (before.state === 'current' || before.state === 'stale')) {
      return out('skip', `the skills index in ${target.path} is not in this gbrain's record (${skillLoadingLedgerPath()}); another gbrain home or install probably wrote it, so it is left as it is. Pass --skill-loading off to remove it from here`);
    }
    const revocation = opts.dryRun ? {} : revokeLoader(prior);
    if (revocation.problem) return out('preserve', `${revocation.problem}; fix that, then re-run. ${target.path} was left as it was`, { reason: 'permission_update_failed' });
    const revoked: Partial<SkillsBlockOutcome> = revocation.removed ? { permission: { ...revocation.removed, change: 'removed' } }
      : opts.dryRun ? plannedPermission('would_remove', revocableRule(prior)) : {};
    // The ledger still records the rule until the opt-out is recorded, so a failure puts it back and a re-run finishes cleanly.
    const putBack = () => (revocation.removed && undoUnrecorded({ path: target.path, settings, restore: revocation.removed }).length ? `; gbrain also could not put back ${revocation.removed.rule} in ${revocation.removed.settings}, so add it back by hand before re-running` : '');
    if (before.state === 'no_file' || before.state === 'absent') {
      try { record('off', false); } catch (e) { return out('preserve', `recording the opt-out failed: ${message(e)}${putBack()}`, { reason: 'write_failed' }); }
      return out('skip', `skill loading off: no skills index in ${target.path}`, revoked);
    }
    try {
      const existing = readFileSync(target.path, 'utf8');
      if (!opts.dryRun) {
        const stripped = removeBlock(MARKERS, existing).text;
        if (ownedEmptyFile(prior?.created_file ?? false, target.path, stripped)) unlinkSync(target.path);
        else writeUnlessChanged(target.path, existing, false, stripped);
      }
    } catch (e) {
      return out('preserve', `${target.path} could not be updated (${message(e)}); the skills index is still there${putBack()}`, { reason: 'write_failed' });
    }
    try { record('off', false); } catch (e) {
      return out('preserve', `the skills index was removed from ${target.path}, but recording the opt-out in ${skillLoadingLedgerPath()} failed (${message(e)}); re-run to record it${putBack()}`, { reason: 'recorded_partially' });
    }
    return out('remove', `skills index from ${target.path}`, revoked);
  }

  if (body === undefined) return out('preserve', `${tooLarge!.message}; ${target.path} was left as it was`, { reason: 'index_too_large' });
  const served = launcherCatalog(launcher);
  if ('error' in served) return out('preserve', `${served.error}; ${target.path} was left as it was. Pass --gbrain-bin <absolute path of this gbrain>`, { reason: 'launcher_unusable' });
  if (served.catalog !== bundledCatalogId()) {
    return out('preserve', `${launcher} serves skill catalog ${served.catalog}, not this gbrain's ${bundledCatalogId()}, so the index would load other text than it lists; ${target.path} was left as it was. Pass --gbrain-bin <absolute path of this gbrain>, or upgrade that install`, { reason: 'launcher_catalog_mismatch' });
  }
  if (target.harness === 'hermes' && (before.state === 'no_file' || (() => { try { return readFileSync(target.path, 'utf8').trim() === ''; } catch { return true; } })())) {
    return out('skip', `${target.path} is missing or empty, and Hermes uses a non-empty SOUL.md instead of its default identity; start Hermes once (it seeds SOUL.md) or write your identity there, then re-run`, { reason: 'hermes_soul_missing' });
  }
  const brainFirstCreated = readBrainFirstLedger().find((e) => e.harness === target.harness && e.path === target.path)?.created_file ?? false;
  const created = before.state === 'no_file' && !direntExists(target.path);
  const createdFile = created || (prior?.created_file ?? false) || brainFirstCreated;
  let written: { before: string | null; after: string } | undefined;
  if (before.state !== 'current' && !opts.dryRun) {
    try {
      const existing = before.state === 'no_file' ? (created && target.harness === 'cursor' ? CURSOR_HEAD : '') : readFileSync(target.path, 'utf8');
      const next = placeSkillsBlock(existing, body);
      writeUnlessChanged(target.path, existing, before.state === 'no_file', next);
      written = { before: before.state === 'no_file' ? null : existing, after: next };
      if (created && target.project) {
        try { ensureGitExcluded(target.path); } catch { /* a project file outside git stays as written */ }
      }
    } catch (e) {
      return out('preserve', `${target.path} could not be updated (${message(e)}); nothing was changed`, { reason: 'write_failed' });
    }
  }
  const done = before.state === 'current'
    ? out('keep', `skills index in ${target.path} is current`)
    : out('write', `skills index ${before.state === 'stale' ? 'refreshed in' : created ? 'in new file' : 'added to'} ${target.path}`);
  if (opts.dryRun) {
    if (target.harness !== 'claude-code') return done;
    const rule = loaderAllowRule(launcher);
    const old = plannedPermission('would_remove', revocableRule(prior, { rule, settings })).permission;
    const replacedPreview: Partial<SkillsBlockOutcome> = old ? { replaced_permission: { rule: old.rule, settings: old.settings, change: 'would_remove' } } : {};
    if (userRemovedRule(prior, rule, settings) && decision.source !== 'flag') return { ...done, ...replacedPreview };
    return { ...done, ...replacedPreview, ...plannedPermission('would_add', { rule, settings }) };
  }
  const priorGrant: Grant = prior?.allow_rule
    ? { allow_rule: prior.allow_rule, allow_settings: prior.allow_settings, allow_owned: prior.allow_owned, ...(prior.allow_declined ? { allow_declined: true } : {}) }
    : {};
  const rule = target.harness === 'claude-code' ? loaderAllowRule(launcher) : undefined;
  let grant: Grant = priorGrant;
  const replaced = revokeLoader(prior, { rule, settings });
  let permissionProblem = replaced.problem;
  let added = false;
  let declined = false;
  if (!permissionProblem) {
    try {
      ({ grant, added, declined } = grantLoader(target.harness, launcher, settings, prior, decision.source === 'flag'));
    } catch (e) {
      grant = priorGrant.allow_rule === rule && ruleSettings(priorGrant) === settings ? priorGrant : {};
      permissionProblem = `the Claude Code permission rule ${rule} could not be added to ${settings} (${message(e)}), so Claude Code will ask before each skill load`;
    }
  }
  try {
    record('spring', createdFile, grant);
  } catch (e) {
    const left = undoUnrecorded({ path: target.path, written, rule: added ? grant.allow_rule : undefined, settings, restore: replaced.removed });
    if (left.length === 0) return out('preserve', `recording the skills index in ${skillLoadingLedgerPath()} failed (${message(e)}), so this run's changes were undone and nothing changed; fix that, then re-run`, { reason: 'write_failed' });
    return out('preserve', `recording the skills index in ${skillLoadingLedgerPath()} failed (${message(e)}), and gbrain could not undo ${left.join(' and ')}; remove ${left.length > 1 ? 'them' : 'it'} by hand before re-running, because a re-run would take ${left.length > 1 ? 'them' : 'it'} for yours`, { reason: 'recorded_partially' });
  }
  if (replaced.removed) done.replaced_permission = { ...replaced.removed, change: 'removed' };
  if (permissionProblem) return { ...done, action: 'preserve', detail: `${done.detail} (the index is in place; the permission step did not finish): ${permissionProblem}`, reason: 'permission_update_failed' };
  if (declined) return { ...done, detail: `${done.detail}; the Claude Code rule ${rule} was removed from ${settings} after gbrain added it, so gbrain left it out and Claude Code will ask before each skill load (re-run with --skill-loading spring to add it again)` };
  return added && grant.allow_rule ? { ...done, detail: `${done.detail}; Claude Code may now run ${grant.allow_rule}`, permission: { rule: grant.allow_rule, settings, change: 'added' } } : done;
}

/**
 * A run whose ledger write failed takes back what it changed, so no rule or
 * file is left that the ledger does not know gbrain wrote. Returns what could
 * not be undone.
 */
function undoUnrecorded(opts: { path: string; written?: { before: string | null; after: string }; rule?: string; settings: string; restore?: { rule: string; settings: string } }): string[] {
  const left: string[] = [];
  if (opts.restore) {
    try {
      addPermissionsAllowEntry(opts.restore.settings, opts.restore.rule);
    } catch {
      left.push(`the removal of the rule ${opts.restore.rule} from ${opts.restore.settings} (add it back)`);
    }
  }
  if (opts.rule) {
    try {
      if (removePermissionsAllowEntry(opts.settings, opts.rule).notes.some((n) => n.startsWith('WARNING'))) left.push(`the rule ${opts.rule} in ${opts.settings}`);
    } catch {
      left.push(`the rule ${opts.rule} in ${opts.settings}`);
    }
  }
  if (opts.written) {
    try {
      if (opts.written.before === null) {
        if (readFileSync(opts.path, 'utf8') !== opts.written.after) throw new Error('changed');
        unlinkSync(opts.path);
      } else {
        writeUnlessChanged(opts.path, opts.written.after, false, opts.written.before);
      }
    } catch {
      left.push(`the skills block in ${opts.path}`);
    }
  }
  return left;
}

/** The uninstall path: strip the block, delete the file only when gbrain created it and nothing else is left, forget the record. */
export function removeSkillsBlock(opts: { harness: string; path: string; dryRun: boolean }): SkillsBlockOutcome {
  const before = inspectSkillsBlock(opts.path);
  const decision: SkillLoadingDecision = { value: 'off', source: 'flag' };
  const out = (action: SkillsBlockOutcome['action'], detail: string, extra: Partial<SkillsBlockOutcome> = {}): SkillsBlockOutcome =>
    ({ harness: opts.harness, path: opts.path, decision, action, state_before: before.state, detail, ...extra });
  let prior: SkillLoadingLedgerEntry | undefined;
  try {
    prior = priorSkillLoading(opts.harness, opts.path);
  } catch (e) {
    return out('preserve', `${message(e)}; ${opts.path} was left as it was`, { reason: 'ledger_unreadable' });
  }
  if (before.state === 'damaged') return out('preserve', `the skills markers in ${opts.path} were hand-edited; remove the block by hand`, { reason: 'damaged_markers' });
  if (opts.dryRun) {
    const planned = plannedPermission('would_remove', revocableRule(prior));
    return before.state === 'no_file' || before.state === 'absent' ? out('skip', `no skills index in ${opts.path}`, planned) : out('remove', `skills index from ${opts.path}`, planned);
  }
  const revocation = revokeLoader(prior);
  if (revocation.problem) return out('preserve', `${revocation.problem}; fix that, then re-run. ${opts.path} was left as it was`, { reason: 'permission_update_failed' });
  const permission: Partial<SkillsBlockOutcome> = revocation.removed ? { permission: { ...revocation.removed, change: 'removed' } } : {};
  let deleteFile = false;
  if (before.state !== 'no_file' && before.state !== 'absent') {
    try {
      const existing = readFileSync(opts.path, 'utf8');
      const stripped = removeBlock(MARKERS, existing).text;
      deleteFile = ownedEmptyFile(prior?.created_file ?? false, opts.path, stripped);
      if (deleteFile) unlinkSync(opts.path);
      else writeUnlessChanged(opts.path, existing, false, stripped);
    } catch (e) {
      const left = revocation.removed ? undoUnrecorded({ path: opts.path, settings: revocation.removed.settings, restore: revocation.removed }) : [];
      return out('preserve', `${opts.path} could not be updated (${message(e)}); the skills index is still there${left.length ? `, and gbrain could not put back ${revocation.removed!.rule} in ${revocation.removed!.settings}; add it back by hand` : ''}`, { reason: 'write_failed' });
    }
  }
  try { dropLedger(opts.harness, opts.path); } catch (e) {
    return out('preserve', `the skills index was removed from ${opts.path}, but ${skillLoadingLedgerPath()} could not be updated (${message(e)}); re-run to finish`, { reason: 'recorded_partially' });
  }
  return before.state === 'no_file' || before.state === 'absent'
    ? out('skip', `no skills index in ${opts.path}`, permission)
    : out('remove', `skills index from ${opts.path}${deleteFile ? ' (file removed: gbrain created it and nothing else was in it)' : ''}`, permission);
}

/** One human line per outcome, matching setup's step lines. */
export function describeSkillsBlockOutcome(o: SkillsBlockOutcome, dryRun: boolean): string {
  const how = o.decision.value === 'spring' ? 'turn off with --skill-loading off' : 'turn on with --skill-loading spring';
  const tag = o.decision.source === 'unresolved' ? '' : ` [${o.decision.source}; ${how}]`;
  const rule = (p: { rule: string; settings: string; change: string } | undefined) =>
    p && p.change !== 'added' ? `; ${p.change.replace('_', ' ')} Claude Code permission ${p.rule} in ${p.settings}` : '';
  return `  ${(dryRun && o.action !== 'keep' && o.action !== 'skip' ? `would ${o.action}` : o.action).padEnd(8)} ${'skills'.padEnd(7)} ${o.detail}${rule(o.replaced_permission)}${rule(o.permission)}${tag}`;
}

/**
 * The installer lanes (`gbrain connect --install`, `gbrain connect --harness`,
 * `gbrain bootstrap harness`): the same decision as setup (flag, then
 * GBRAIN_SKILL_LOADING, then the recorded choice, then off), with the
 * brain-first outcome deciding `--no-instructions`. Never throws.
 */
export function installerSkillsBlock(opts: {
  target: BrainFirstTarget; launcher: string; writer: string; brainFirstDeclined: boolean;
  skillLoading?: SkillLoading; audience?: SkillAudience; remove?: boolean; dryRun?: boolean; settingsPath?: string;
}): SkillsBlockOutcome {
  if (opts.remove) return removeSkillsBlock({ harness: opts.target.harness, path: opts.target.path, dryRun: opts.dryRun ?? false });
  let decision: SkillLoadingDecision;
  try {
    decision = opts.brainFirstDeclined
      ? { value: 'off', source: 'instructions_off' }
      : resolveSkillLoading(opts.skillLoading, priorSkillLoading(opts.target.harness, opts.target.path));
  } catch (e) {
    const reason: SkillsBlockReason = e instanceof InvalidSkillLoadingEnv ? 'invalid_env' : 'ledger_unreadable';
    return { harness: opts.target.harness, path: opts.target.path, decision: { value: 'off', source: 'unresolved' }, action: 'preserve', state_before: inspectSkillsBlock(opts.target.path).state, detail: `${message(e)}; ${opts.target.path} was left as it was`, reason };
  }
  return syncSkillsBlock({ target: opts.target, launcher: opts.launcher, decision, writer: opts.writer, dryRun: opts.dryRun ?? false, audience: opts.audience, settingsPath: opts.settingsPath });
}

/** A preserve outcome when the ledger cannot be read, else undefined. */
function ledgerProblem(): SkillsBlockOutcome | undefined {
  try {
    readSkillLoadingLedger();
    return undefined;
  } catch (e) {
    return { harness: '*', path: skillLoadingLedgerPath(), decision: { value: 'off', source: 'unresolved' }, action: 'preserve', state_before: 'damaged', detail: message(e), reason: 'ledger_unreadable' };
  }
}

/** Removal for a lane that records its writer: strip every index that writer wrote, except those `keep` claims. */
export function removeSkillsBlocksBy(writer: string, opts: { dryRun?: boolean; keep?: (e: SkillLoadingLedgerEntry) => boolean } = {}): SkillsBlockOutcome[] {
  const unreadable = ledgerProblem();
  if (unreadable) return [unreadable];
  const dryRun = opts.dryRun ?? false;
  return readSkillLoadingLedger().filter((e) => e.writer === writer && e.mode === 'spring' && !opts.keep?.(e)).map((e) => removeSkillsBlock({ harness: e.harness, path: e.path, dryRun }));
}

/** launcher_missing: the block is in place but the gbrain it names is gone, so every load fails. ledger_unreadable: gbrain cannot tell which indexes it wrote. */
export type SkillsIndexState = SkillsBlockState | 'launcher_missing' | 'ledger_unreadable';
export interface SkillsIndexView { harness: string; path: string; state: SkillsIndexState; refresh: string }

function launcherRuns(launcher: string): boolean {
  try {
    accessSync(launcher, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Doctor's read of every index the ledger says is on: current, stale (an
 * upgrade changed the catalog), absent (the block was deleted by hand),
 * damaged or no_file. Informational only: a stale index still loads skills
 * by name, so doctor names the refresh command and never warns on it.
 */
export function skillsIndexViews(): SkillsIndexView[] {
  const unreadable = ledgerProblem();
  if (unreadable) return [{ harness: '*', path: skillLoadingLedgerPath(), state: 'ledger_unreadable', refresh: unreadable.detail }];
  return [...readSkillLoadingLedger().filter((e) => e.mode === 'spring').map((e): SkillsIndexView => {
    const state = inspectSkillsBlock(e.path).state;
    if ((state === 'current' || state === 'stale') && e.launcher && isAbsolute(e.launcher) && !launcherRuns(e.launcher)) {
      return { harness: e.harness, path: e.path, state: 'launcher_missing', refresh: `${skillsRefreshCommand(e.harness)} --gbrain-bin <absolute path of gbrain>` };
    }
    return { harness: e.harness, path: e.path, state, refresh: skillsRefreshCommand(e.harness) };
  }), ...thinClientIndexView()];
}

/**
 * A thin-client install (`gbrain connect --harness … --root`) writes its index
 * into GBRAIN-INSTRUCTIONS.md, a file the connection owns whole, so it is
 * recorded in the connection receipt rather than the ledger, and refreshed by
 * re-running that install.
 */
function thinClientIndexView(): SkillsIndexView[] {
  const receiptPath = join(configDir(), 'harness-connection.json');
  if (!existsSync(receiptPath)) return [];
  let receipt: { status?: unknown; skill_loading?: unknown; root?: unknown; mcp_url?: unknown; harness?: unknown };
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as typeof receipt;
  } catch {
    return [];
  }
  if (receipt.status !== 'installed' || receipt.skill_loading !== 'spring' || typeof receipt.root !== 'string') return [];
  const harness = typeof receipt.harness === 'string' ? receipt.harness : 'generic';
  const path = join(receipt.root, 'GBRAIN-INSTRUCTIONS.md');
  const rerun = `gbrain connect ${shellQuote(String(receipt.mcp_url ?? '<mcp-url>'))} --harness ${shellQuote(harness)} --credentials-file <private-handoff-file> --root ${shellQuote(receipt.root)} --install`;
  return [{ harness, path, state: inspectSkillsBlock(path).state, refresh: rerun }];
}


/**
 * `gbrain setup <harness> --skills-index-only` (the refresh the block header
 * and doctor name): re-render every index the ledger records for the
 * harness, in its recorded file, with its recorded launcher (or
 * --gbrain-bin), audience and writer. Brain-first and every other file are
 * left alone. `off` strips them all and records the opt-out; an explicit
 * `spring` is a flag-sourced choice, so it adds back a loader rule the user
 * removed, which a plain refresh does not.
 */
export function refreshSkillsIndexes(harness: BrainFirstHarness, opts: { mode?: SkillLoading; launcher?: string; dryRun: boolean }): SkillsBlockOutcome[] {
  const unreadable = ledgerProblem();
  if (unreadable) return [unreadable];
  const off = opts.mode === 'off';
  const ledger = readSkillLoadingLedger();
  const batch = ledger.filter((e) => e.harness === harness && (off || e.mode === 'spring'));
  const outcomes = batch.map((e) => syncSkillsBlock({
    target: brainFirstTargetAt(harness, e.path),
    launcher: opts.launcher ?? e.launcher ?? indexLauncher() ?? 'gbrain',
    audience: e.audience ?? 'owner',
    decision: off ? { value: 'off', source: 'flag' } : { value: 'spring', source: opts.mode === 'spring' ? 'flag' : 'prior' },
    writer: e.writer,
    dryRun: opts.dryRun,
  }));
  if (!opts.dryRun || harness !== 'claude-code') return outcomes;
  // Each row previewed alone sees the others still owning a shared rule. When the batch drops that rule from every
  // row (an opt-out, or a launcher change), its last owner is the one that takes it out, so that row shows the removal.
  const owners = (e: SkillLoadingLedgerEntry) => e.mode === 'spring' && e.allow_owned === true && e.allow_rule !== undefined;
  const drops = (e: SkillLoadingLedgerEntry) => off || loaderAllowRule(opts.launcher ?? e.launcher ?? '') !== e.allow_rule;
  const shown = (o: SkillsBlockOutcome, rule: string) => (off ? o.permission : o.replaced_permission)?.rule === rule;
  batch.forEach((e, i) => {
    if (!owners(e) || !drops(e) || outcomes.some((o) => shown(o, e.allow_rule!))) return;
    const settings = ruleSettings(e);
    const sameRule = (x: SkillLoadingLedgerEntry) => owners(x) && x.allow_rule === e.allow_rule && ruleSettings(x) === settings;
    if (ledger.some((x) => sameRule(x) && (!batch.includes(x) || !drops(x)))) return;
    if (batch.map((x, j) => (sameRule(x) ? j : -1)).filter((j) => j >= 0).pop() !== i) return;
    const removal = plannedPermission('would_remove', { rule: e.allow_rule!, settings }).permission;
    if (!removal) return;
    if (off) outcomes[i]!.permission = removal;
    else outcomes[i]!.replaced_permission = { rule: removal.rule, settings: removal.settings, change: 'would_remove' };
  });
  return outcomes;
}
