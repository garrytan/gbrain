/**
 * pinned-block.ts — renders an operator's pinned skills
 * (`skills.resolver.pins.<catalog>`, written by `gbrain skills pin`,
 * src/core/setup/skill-pins.ts) against a built catalog's index. It reads
 * no config and writes nothing, so the hook lane's worker (hook-worker.ts)
 * renders the Claude Code and Codex SessionStart block with it without the
 * setup module graph.
 *
 * Each pin is a skill id that must be in the catalog's index and an optional
 * trigger-first line (one line, at most PIN_LINE_MAX characters, no angle
 * brackets). Rendering drops any pin the catalog no longer holds and reports
 * it, so an unknown name never reaches the model, and cuts the block at whole
 * lines to PIN_BLOCK_TOKEN_CAP. The same pins always render the same bytes,
 * which keeps the host's prompt cache warm.
 */
import { estimateTokens, loadLine, quoted } from './block.ts';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { IndexReader } from './index-format.ts';
import { catalogFile, validCatalogName } from './paths.ts';
import { claudeUserSkillsDir } from '../../bootstrap/host-specs.ts';

export const PIN_LINE_MAX = 100;
export const PIN_BLOCK_TOKEN_CAP = 600;

/** The OpenClaw session classes a pin shows in: the owner's own sessions (the default) and conversations (groups, channels, other people's DMs). */
export type PinClass = 'owner' | 'conversation';
export const PIN_CLASSES: readonly PinClass[] = ['owner', 'conversation'];
/** brief: OpenClaw shows the pin once per owner session (the session-start brief) instead of on every turn. */
export interface Pin { name: string; line?: string; classes?: PinClass[]; brief?: true }
export interface PinnedBlock { block: string; tokens: number; ids: string[]; unknown: string[]; cut: string[] }

/** Why a pin is not valid as written, or null. */
export function pinProblem(pin: Pin): string | null {
  if (!pin.name || pin.name.length > 256 || /[\u0000-\u001f\u007f<>]/.test(pin.name)) return 'the skill name must be 1-256 visible characters with no < or >';
  if (pin.line !== undefined && (pin.line.length === 0 || pin.line.length > PIN_LINE_MAX || /[\u0000-\u001f\u007f<>]/.test(pin.line))) return `--line must be one line of 1-${PIN_LINE_MAX} characters with no < or >`;
  return null;
}

/** One catalog's stored pins, in the operator's order; malformed entries are skipped. */
export function parsePins(raw: unknown): Pin[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p): Pin[] => {
    if (!p || typeof p !== 'object') return [];
    const { name, line, classes, brief } = p as { name?: unknown; line?: unknown; classes?: unknown; brief?: unknown };
    if (typeof name !== 'string') return [];
    const cls = Array.isArray(classes) ? PIN_CLASSES.filter((c) => classes.includes(c)) : [];
    const pin: Pin = { name, ...(typeof line === 'string' ? { line } : {}), ...(cls.length && (cls.length !== 1 || cls[0] !== 'owner') ? { classes: cls } : {}), ...(brief === true ? { brief: true as const } : {}) };
    return pinProblem(pin) ? [] : [pin];
  });
}

/** The skill ids a built catalog holds, or null when it has no readable index. */
export function catalogSkillIds(home: string, catalog: string): Set<string> | null {
  const paths = catalogSkillPaths(home, catalog);
  return paths ? new Set(paths.keys()) : null;
}

/** Each skill id a built catalog holds with its SKILL.md path ('' when the index has none), or null when it has no readable index. */
export function catalogSkillPaths(home: string, catalog: string): Map<string, string> | null {
  return catalogSkills(home, catalog)?.paths ?? null;
}

/** A built catalog's skill paths and the ids marked `audience: owner`, or null when it has no readable index. */
export function catalogSkills(home: string, catalog: string): { paths: Map<string, string>; ownerOnly: Set<string> } | null {
  if (!validCatalogName(catalog)) return null;
  let ix: IndexReader | null = null;
  try {
    ix = IndexReader.open(catalogFile(home, catalog, 'index.bin'));
    const paths = new Map<string, string>();
    const ownerOnly = new Set<string>();
    for (let d = 0; d < ix.n; d++) { const m = ix.meta(d); paths.set(m.id, m.path ?? ''); if (m.aud) ownerOnly.add(m.id); }
    return { paths, ownerOnly };
  } catch { return null; } finally { ix?.close(); }
}

/**
 * The pinned block for one harness. With `known` set, a pin the catalog does
 * not hold is left out and listed in `unknown`; with null (no index yet)
 * nothing renders, because an unchecked name must never reach the model.
 * With paths, each line also names the skill's SKILL.md, for a harness
 * that loads a skill by reading its file. With brief, it renders OpenClaw's
 * once-per-session list (<session_brief>) instead of the every-turn block.
 */
export function renderPinnedBlock(pins: readonly Pin[], opts: { harness?: string; known: Set<string> | null; cap?: number; paths?: ReadonlyMap<string, string>; readRoot?: string; brief?: boolean }): PinnedBlock {
  const cap = opts.cap ?? PIN_BLOCK_TOKEN_CAP;
  if (!opts.known) return { block: '', tokens: 0, ids: [], unknown: pins.map((p) => p.name), cut: [] };
  const valid = pins.filter((p) => opts.known!.has(p.name));
  const unknown = pins.filter((p) => !opts.known!.has(p.name)).map((p) => p.name);
  const lines = valid.map((p) => `- id: ${quoted(p.name)}${p.line ? ` when: ${quoted(p.line)}` : ''}${opts.paths?.get(p.name) ? ` path: ${quoted(opts.paths.get(p.name)!)}` : ''}`);
  const pathed = opts.harness === 'claude-code' && valid.some((p) => opts.paths?.get(p.name));
  const head = `${opts.brief ? 'Skills for this session, chosen by this agent\'s operator, whether or not a skill list shows them.' : 'Always-available skills, chosen by this agent\'s operator, whether or not a skill list shows them.'} ${loadLine(opts.harness, undefined, { readRoot: opts.readRoot, paths: valid.map((p) => opts.paths?.get(p.name)) })}${pathed ? ' A skill listed with a path is outside Claude Code\'s skills folder: read the SKILL.md at its path instead.' : ''}`;
  const tag = opts.brief ? 'session_brief' : 'pinned_skills';
  const wrap = (body: string[]) => [`<${tag}>`, head, ...body, `</${tag}>`].join('\n');
  const kept: number[] = [];
  lines.forEach((line, i) => { if (estimateTokens(wrap([...kept.map((k) => lines[k]), line])) <= cap) kept.push(i); });
  if (!kept.length) return { block: '', tokens: 0, ids: [], unknown, cut: valid.map((p) => p.name) };
  const block = wrap(kept.map((k) => lines[k]));
  return { block, tokens: estimateTokens(block), ids: kept.map((k) => valid[k].name), unknown, cut: valid.filter((_, i) => !kept.includes(i)).map((p) => p.name) };
}

/**
 * The pinned block the Claude Code and Codex hook lane prints at SessionStart, from <harness>-user's pins; Codex's lines
 * also name each SKILL.md, as its load line opens the file. A Claude Code pin from a configured extra directory names its
 * SKILL.md too, because the Skill tool loads only skills in Claude Code's own skills folder.
 */
export function sessionStartPinnedBlock(home: string, harness: 'claude-code' | 'codex', pins: readonly Pin[]): PinnedBlock {
  const catalog = `${harness}-user`;
  const paths = catalogSkillPaths(home, catalog);
  if (harness === 'claude-code') {
    const dir = claudeUserSkillsDir();
    const native = (() => { try { return realpathSync(dir); } catch { return dir; } })() + sep;
    const outside = paths ? new Map([...paths].filter(([, path]) => path && !path.startsWith(native))) : null;
    return renderPinnedBlock(pins, { harness, known: paths ? new Set(paths.keys()) : null, ...(outside?.size ? { paths: outside } : {}) });
  }
  return renderPinnedBlock(pins, { harness, known: paths ? new Set(paths.keys()) : null, ...(paths ? { paths } : {}) });
}
