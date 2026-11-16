/**
 * skill-resolver-config.ts — the skill resolver's file-plane keys in
 * <config dir>/config.json, read and written engine-free:
 *
 *   skills.resolver.enabled            true while setup has the lane on for any harness
 *   skills.resolver.harnesses          the harnesses setup turned it on for
 *   skills.resolver.session_token_budget, skills.resolver.auto_rebuild
 *                                      (PR A's settings, src/core/skills/resolver/config.ts)
 *   skills.resolver.lane_payload_chars the hook lane's payload budget (500..10000, default 4000)
 *   skills.resolver.top_k, min_match, top_gate, pinned, per_harness.<harness>.{top_k,min_match,top_gate,dirs}
 *                                      the hook lane's turn settings (src/core/skills/resolver/config.ts)
 *
 * A missing file is created with only these keys: no engine, no database, so
 * a brainless install stays brainless (loadConfig decides "a brain is
 * configured" from an engine, a database or a remote endpoint, never from
 * the file existing). A file that exists but cannot be read or parsed is
 * never rewritten: skill_resolver_config_unreadable.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { setCliExitVerdict } from '../cli-force-exit.ts';
import { laneTurnSettings, validateMinMatch, validateOwnerSenders, validatePinned, validateSessionTokenBudget, validateSkillDirs, validateTopGate, validateTopK } from '../skills/resolver/config.ts';

const CONFIG_CAP_BYTES = 1024 * 1024;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A JSON object file, or null when it is missing, unreadable or not an object. */
export function readJsonObjectSafe(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

export type ResolverConfigRead = { state: 'absent'; path: string } | { state: 'ok'; path: string; doc: Record<string, unknown> } | { state: 'unreadable'; path: string; why: string };

export function readResolverConfig(home: string): ResolverConfigRead {
  const path = join(home, 'config.json');
  if (!existsSync(path)) return { state: 'absent', path };
  try {
    if (statSync(path).size > CONFIG_CAP_BYTES) return { state: 'unreadable', path, why: 'it is over 1 MB' };
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { state: 'unreadable', path, why: 'it is not a JSON object' };
    return { state: 'ok', path, doc: v as Record<string, unknown> };
  } catch (e) {
    return { state: 'unreadable', path, why: e instanceof SyntaxError ? 'it is not valid JSON' : (e as Error).message };
  }
}

export function resolverSection(doc: Record<string, unknown>): Record<string, unknown> {
  const r = (doc.skills as { resolver?: unknown } | undefined)?.resolver;
  return r && typeof r === 'object' && !Array.isArray(r) ? r as Record<string, unknown> : {};
}

/** The harnesses setup has the lane on for (empty when off or unconfigured). */
export function resolverHarnesses(doc: Record<string, unknown> | null): string[] {
  if (!doc) return [];
  const r = resolverSection(doc);
  return r.enabled === true && Array.isArray(r.harnesses) ? r.harnesses.filter((h): h is string => typeof h === 'string') : [];
}

/**
 * Add or drop one harness. Returns what changed (nothing when the keys
 * already say so). Dropping the last harness removes enabled and harnesses,
 * then empty skills.resolver and skills objects, and a config.json left
 * empty. The caller has checked the file is readable.
 */
export function setResolverHarness(read: Exclude<ResolverConfigRead, { state: 'unreadable' }>, harness: string, on: boolean, dryRun: boolean): { changed: boolean; keys: string[]; deletedFile: boolean } {
  const doc = read.state === 'ok' ? structuredClone(read.doc) : {};
  const before = resolverHarnesses(read.state === 'ok' ? read.doc : null);
  const next = on ? [...new Set([...before, harness])].sort() : before.filter((h) => h !== harness);
  const r = resolverSection(doc);
  const changed = on ? !(before.includes(harness) && r.enabled === true) : before.includes(harness) || (next.length === 0 && ('enabled' in r || 'harnesses' in r));
  if (!changed) return { changed: false, keys: [], deletedFile: false };
  if (next.length) Object.assign(r, { enabled: true, harnesses: next });
  else { delete r.enabled; delete r.harnesses; }
  const skills = (doc.skills && typeof doc.skills === 'object' && !Array.isArray(doc.skills) ? doc.skills : {}) as Record<string, unknown>;
  if (Object.keys(r).length) skills.resolver = r; else delete skills.resolver;
  if (Object.keys(skills).length) doc.skills = skills; else delete doc.skills;
  const keys = ['skills.resolver.enabled', 'skills.resolver.harnesses'];
  const deletedFile = Object.keys(doc).length === 0;
  if (!dryRun) {
    if (deletedFile) { try { unlinkSync(read.path); } catch { /* never created */ } }
    else atomicWriteTextFile(read.path, `${JSON.stringify(doc, null, 2)}\n`, { freshMode: 0o600 });
  }
  return { changed: true, keys, deletedFile };
}

export const SKILL_RESOLVER_KEY_PREFIX = 'skills.resolver.';
/** The leaves `gbrain config set|unset|get` accepts (harnesses is setup's: --skill-loading resolve|off). */
export const SKILL_RESOLVER_CONFIG_LEAVES = ['enabled', 'session_token_budget', 'auto_rebuild', 'lane_payload_chars', 'top_k', 'min_match', 'top_gate', 'pinned', 'per_harness.<harness>.top_k', 'per_harness.<harness>.min_match', 'per_harness.<harness>.top_gate', 'per_harness.<harness>.dirs', 'per_harness.hermes.owner_sender_ids'] as const;
const PER_HARNESS_LEAF = /^per_harness\.([a-z-]+)\.(top_k|min_match|top_gate|dirs|owner_sender_ids)$/;

function parseLeafValue(leaf: string, value: string): { ok: true; value: boolean | number | string | string[] } | { ok: false; error: string } {
  const turnKey = leaf.match(PER_HARNESS_LEAF)?.[2] ?? leaf;
  const key = `${SKILL_RESOLVER_KEY_PREFIX}${leaf}`;
  try {
    if (turnKey === 'top_k') return { ok: true, value: validateTopK(/^\d+$/.test(value) ? Number(value) : NaN, key) };
    if (turnKey === 'min_match') return { ok: true, value: validateMinMatch(value, key) };
    if (turnKey === 'top_gate') return { ok: true, value: validateTopGate(/^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN, key) };
    if (turnKey === 'dirs') return { ok: true, value: validateSkillDirs(value.split(',').map(s => s.trim()).filter(Boolean), key) };
    if (leaf === 'pinned') return { ok: true, value: validatePinned(value.split(',').map(s => s.trim()).filter(Boolean), key) };
    if (turnKey === 'owner_sender_ids') return { ok: true, value: validateOwnerSenders(value.split(',').map(s => s.trim()).filter(Boolean), key) };
  } catch (e) { return { ok: false, error: (e as Error).message.slice(key.length + 1) }; }
  if (leaf === 'enabled' || leaf === 'auto_rebuild') {
    if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
    return { ok: false, error: 'must be true or false' };
  }
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (leaf === 'lane_payload_chars') return Number.isSafeInteger(n) && n >= 500 && n <= 10_000 ? { ok: true, value: n } : { ok: false, error: 'must be a whole number of characters from 500 to 10000 (default 4000)' };
  try { return { ok: true, value: validateSessionTokenBudget(n, `${SKILL_RESOLVER_KEY_PREFIX}session_token_budget`) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/**
 * `gbrain config set|unset|get skills.resolver.<leaf>`, engine-free (before
 * any brain connection, on a brainless install and on a thin client alike):
 * the file plane is the only plane these keys have. A per_harness entry that
 * is not an object (a hand-edited null, list or scalar) reads as unset, and
 * set or unset replaces it with {}. Returns false for a key or action this
 * does not own.
 */
export function runSkillResolverConfigKey(args: string[], home: string): boolean {
  const [action, key, ...rest] = args;
  if (!key?.startsWith(SKILL_RESOLVER_KEY_PREFIX) || !['set', 'unset', 'get'].includes(action ?? '')) return false;
  const leaf = key.slice(SKILL_RESOLVER_KEY_PREFIX.length);
  const fail = (msg: string): true => { console.error(`[config] ${msg}`); setCliExitVerdict(1); return true; };
  if (leaf === 'harnesses') return fail(`${key} is written by gbrain setup <claude-code|codex|hermes> --skill-loading resolve (and removed by --skill-loading off); nothing was written.`);
  const nested = leaf.match(PER_HARNESS_LEAF);
  if (!nested && !(SKILL_RESOLVER_CONFIG_LEAVES as readonly string[]).includes(leaf)) return fail(`Unknown config key "${key}". skills.resolver keys: ${SKILL_RESOLVER_CONFIG_LEAVES.join(', ')}. Nothing was written.`);
  const read = readResolverConfig(home);
  if (read.state === 'unreadable') return fail(`${read.path} cannot be read (${read.why}); fix it first (skill_resolver_config_unreadable). Nothing was written.`);
  const doc = read.state === 'ok' ? structuredClone(read.doc) : {};
  const section = resolverSection(doc);
  const perHarness = (section.per_harness && typeof section.per_harness === 'object' && !Array.isArray(section.per_harness) ? section.per_harness : {}) as Record<string, Record<string, unknown>>;
  const stored: unknown = nested && Object.hasOwn(perHarness, nested[1]!) ? perHarness[nested[1]!] : undefined;
  const replaced = !!nested && stored !== undefined && !isPlainObject(stored);
  const holder: Record<string, unknown> = !nested ? section : isPlainObject(stored) ? stored : (perHarness[nested[1]!] = {});
  const field = nested ? nested[2]! : leaf;
  if (action === 'get') {
    if (holder[field] === undefined) return fail(`Config key not found: ${key}`);
    console.log(typeof holder[field] === 'string' ? holder[field] : JSON.stringify(holder[field]));
    return true;
  }
  if (action === 'unset') {
    if (!(field in holder) && !replaced) return fail(`Config key not found: ${key}`);
    delete holder[field];
  } else {
    const value = rest.find((a) => !a.startsWith('-'));
    if (value === undefined) return fail(`usage: gbrain config set ${key} <value>`);
    const parsed = parseLeafValue(leaf, value);
    if (!parsed.ok) return fail(`${key} ${parsed.error}`);
    holder[field] = parsed.value;
  }
  if (nested) {
    for (const [h, o] of Object.entries(perHarness)) if (isPlainObject(o) && Object.keys(o).length === 0) delete perHarness[h];
    if (Object.keys(perHarness).length) section.per_harness = perHarness; else delete section.per_harness;
    try { laneTurnSettings(section, nested[1]!); } catch (e) { return fail(`${(e as Error).message} Nothing was written.`); }
  }
  const skills = (doc.skills && typeof doc.skills === 'object' && !Array.isArray(doc.skills) ? doc.skills : {}) as Record<string, unknown>;
  if (Object.keys(section).length) skills.resolver = section; else delete skills.resolver;
  if (Object.keys(skills).length) doc.skills = skills; else delete doc.skills;
  if (Object.keys(doc).length === 0) unlinkSync(read.path);
  else atomicWriteTextFile(read.path, `${JSON.stringify(doc, null, 2)}\n`, { freshMode: 0o600 });
  console.log(action === 'set' ? `Set ${key} = ${JSON.stringify(holder[field])} (file plane: ${read.path})` : `Unset ${key} (file plane)`);
  return true;
}
