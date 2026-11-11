/**
 * skill-pins.ts — the operator's always-on skills for one catalog
 * (`gbrain skills pin add|remove|list`), stored in the file plane at
 * config.json `skills.resolver.pins.<catalog>` so a `--skill-loading off`
 * (which removes the derived skill-index state) never deletes them.
 *
 * gbrain ships no pins: a catalog with none renders no pinned block. Each pin
 * is a skill id that must be in the catalog's index and an optional
 * trigger-first line (one line, at most 100 characters, no angle brackets).
 * Rendering drops any pin the catalog no longer holds and reports it, so an
 * unknown name never reaches the model, and cuts the block at whole lines to
 * PIN_BLOCK_TOKEN_CAP. The same pins always render the same bytes, which keeps
 * the host's prompt cache warm.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { estimateTokens, loadLine, quoted } from '../skills/resolver/block.ts';
import { IndexReader } from '../skills/resolver/index-format.ts';
import { catalogFile, validCatalogName } from '../skills/resolver/paths.ts';
import { readResolverConfig, type ResolverConfigRead } from './skill-resolver-config.ts';

export const PIN_LINE_MAX = 100;
export const PINS_MAX = 64;
export const PIN_BLOCK_TOKEN_CAP = 600;

export interface Pin { name: string; line?: string }
export interface PinnedBlock { block: string; tokens: number; ids: string[]; unknown: string[]; cut: string[] }

/** Why a pin is not valid as written, or null. */
export function pinProblem(pin: Pin): string | null {
  if (!pin.name || pin.name.length > 256 || /[\u0000-\u001f\u007f<>]/.test(pin.name)) return 'the skill name must be 1-256 visible characters with no < or >';
  if (pin.line !== undefined && (pin.line.length === 0 || pin.line.length > PIN_LINE_MAX || /[\u0000-\u001f\u007f<>]/.test(pin.line))) return `--line must be one line of 1-${PIN_LINE_MAX} characters with no < or >`;
  return null;
}

function section(doc: Record<string, unknown>): Record<string, unknown> {
  const s = (doc.skills as { resolver?: { pins?: unknown } } | undefined)?.resolver?.pins;
  return s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {};
}

/** The pins for one catalog, in the operator's order; malformed entries are skipped. */
export function readPins(read: ResolverConfigRead, catalog: string): Pin[] {
  if (read.state !== 'ok') return [];
  const raw = section(read.doc)[catalog];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p): Pin[] => {
    if (!p || typeof p !== 'object') return [];
    const { name, line } = p as { name?: unknown; line?: unknown };
    if (typeof name !== 'string') return [];
    const pin: Pin = typeof line === 'string' ? { name, line } : { name };
    return pinProblem(pin) ? [] : [pin];
  });
}

/** Every catalog that has pins. */
export function pinnedCatalogs(read: ResolverConfigRead): string[] {
  return read.state === 'ok' ? Object.keys(section(read.doc)).filter(validCatalogName).sort() : [];
}

/** Replace one catalog's pins (an empty list removes the key, then any object it leaves empty). The caller checked the file is readable. */
export function writePins(read: Exclude<ResolverConfigRead, { state: 'unreadable' }>, catalog: string, pins: Pin[]): void {
  const doc = read.state === 'ok' ? structuredClone(read.doc) : {};
  const skills = (doc.skills && typeof doc.skills === 'object' && !Array.isArray(doc.skills) ? doc.skills : {}) as Record<string, unknown>;
  const resolver = (skills.resolver && typeof skills.resolver === 'object' && !Array.isArray(skills.resolver) ? skills.resolver : {}) as Record<string, unknown>;
  const all = section(doc);
  if (pins.length) all[catalog] = pins.map((p) => (p.line ? { name: p.name, line: p.line } : { name: p.name }));
  else delete all[catalog];
  if (Object.keys(all).length) resolver.pins = all; else delete resolver.pins;
  if (Object.keys(resolver).length) skills.resolver = resolver; else delete skills.resolver;
  if (Object.keys(skills).length) doc.skills = skills; else delete doc.skills;
  if (Object.keys(doc).length === 0) { if (existsSync(read.path)) unlinkSync(read.path); return; }
  atomicWriteTextFile(read.path, `${JSON.stringify(doc, null, 2)}\n`, { freshMode: 0o600 });
}

/** The skill ids a built catalog holds, or null when it has no readable index. */
export function catalogSkillIds(home: string, catalog: string): Set<string> | null {
  if (!validCatalogName(catalog)) return null;
  const path = catalogFile(home, catalog, 'index.bin');
  if (!existsSync(path)) return null;
  let ix: IndexReader | null = null;
  try {
    ix = IndexReader.open(path);
    const ids = new Set<string>();
    for (let d = 0; d < ix.n; d++) ids.add(ix.meta(d).id);
    return ids;
  } catch { return null; } finally { ix?.close(); }
}

/**
 * The pinned block for one harness. With `known` set, a pin the catalog does
 * not hold is left out and listed in `unknown`; with null (no index yet)
 * nothing renders, because an unchecked name must never reach the model.
 */
export function renderPinnedBlock(pins: readonly Pin[], opts: { harness?: string; known: Set<string> | null; cap?: number }): PinnedBlock {
  const cap = opts.cap ?? PIN_BLOCK_TOKEN_CAP;
  if (!opts.known) return { block: '', tokens: 0, ids: [], unknown: pins.map((p) => p.name), cut: [] };
  const valid = pins.filter((p) => opts.known!.has(p.name));
  const unknown = pins.filter((p) => !opts.known!.has(p.name)).map((p) => p.name);
  const lines = valid.map((p) => `- id: ${quoted(p.name)}${p.line ? ` when: ${quoted(p.line)}` : ''}`);
  const head = `Always-available skills, chosen by this agent's operator, whether or not a skill list shows them. ${loadLine(opts.harness)}`;
  for (let kept = lines.length; kept > 0; kept--) {
    const block = ['<pinned_skills>', head, ...lines.slice(0, kept), '</pinned_skills>'].join('\n');
    const tokens = estimateTokens(block);
    if (tokens <= cap) return { block, tokens, ids: valid.slice(0, kept).map((p) => p.name), unknown, cut: valid.slice(kept).map((p) => p.name) };
  }
  return { block: '', tokens: 0, ids: [], unknown, cut: valid.map((p) => p.name) };
}

/** One catalog's pins rendered against its current index (what setup writes into a harness's surface). */
export function pinnedBlockFor(home: string, catalog: string, harness?: string): PinnedBlock {
  return renderPinnedBlock(readPins(readResolverConfig(home), catalog), { harness, known: catalogSkillIds(home, catalog) });
}
