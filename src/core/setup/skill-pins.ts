/**
 * skill-pins.ts — the operator's always-on skills for one catalog
 * (`gbrain skills pin add|remove|list`), stored in the file plane at
 * config.json `skills.resolver.pins.<catalog>` so a `--skill-loading off`
 * (which removes the derived skill-index state) never deletes them.
 *
 * gbrain ships no pins: a catalog with none renders no pinned block. The
 * pin rules and the renderer (unknown pins left out, PIN_BLOCK_TOKEN_CAP,
 * same pins same bytes) live in src/core/skills/resolver/pinned-block.ts,
 * re-exported here; this module reads and writes the config. The Claude
 * Code and Codex hook lane prints <harness>-user's block at every
 * SessionStart (sessionStartPinnedBlock, from the lane's worker thread).
 */
import { existsSync, unlinkSync } from 'node:fs';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { catalogSkillPaths, parsePins, renderPinnedBlock, type Pin, type PinnedBlock } from '../skills/resolver/pinned-block.ts';
import { validCatalogName } from '../skills/resolver/paths.ts';
import { readResolverConfig, type ResolverConfigRead } from './skill-resolver-config.ts';

export { catalogSkillIds, catalogSkillPaths, parsePins, PIN_BLOCK_TOKEN_CAP, PIN_LINE_MAX, pinProblem, renderPinnedBlock, sessionStartPinnedBlock, type Pin, type PinnedBlock } from '../skills/resolver/pinned-block.ts';

export const PINS_MAX = 64;

function section(doc: Record<string, unknown>): Record<string, unknown> {
  const s = (doc.skills as { resolver?: { pins?: unknown } } | undefined)?.resolver?.pins;
  return s && typeof s === 'object' && !Array.isArray(s) ? s as Record<string, unknown> : {};
}

/** The pins for one catalog, in the operator's order; malformed entries are skipped. */
export function readPins(read: ResolverConfigRead, catalog: string): Pin[] {
  return read.state === 'ok' ? parsePins(section(read.doc)[catalog]) : [];
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

/** One catalog's pins rendered against its current index (what setup writes into a harness's surface); OpenClaw's lines name each SKILL.md, as its load line reads the path first. */
export function pinnedBlockFor(home: string, catalog: string, harness?: string, readRoot?: string): PinnedBlock {
  const paths = catalogSkillPaths(home, catalog);
  return renderPinnedBlock(readPins(readResolverConfig(home), catalog), { harness, known: paths ? new Set(paths.keys()) : null, ...(harness === 'openclaw' && paths ? { paths } : {}), ...(readRoot === undefined ? {} : { readRoot }) });
}
