/**
 * skillpack/brain-resident-locate.ts — server-side discovery of brain-resident
 * skillpacks for the `list_brain_skillpack` MCP tool (Topology B).
 *
 * Distinct from skill-catalog.ts (host-global prose skills): brain-resident
 * packs are per-SOURCE — a brain can mount several sources, each carrying its
 * own pack. So discovery is scoped by `sourceScopeOpts(ctx)` (in-DB tenancy),
 * not the single host skills dir.
 *
 * Trust posture mirrors skill-catalog: contents are surfaced over HTTP only
 * behind the publish gate (enforced by the op). We NEVER emit a server-side
 * filesystem path to a thin client (#6) — the install hint is the source's git
 * remote spec, which the client can `resolveSource` on its own machine.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { createHash } from 'crypto';

import { parseMarkdown, coerceFrontmatterString } from '../markdown.ts';
import { loadAllSources } from '../sources-load.ts';
import { loadSkillpackManifest } from './manifest-v1.ts';
import { loadState, findEntry } from './state.ts';
import { MAX_SKILL_MD_BYTES } from '../skill-catalog.ts';
import type { BrainEngine } from '../engine.ts';
import { OperationError, type OperationContext } from '../operations.ts';
import { sourceScopeOpts } from '../operations.ts';

export interface ResidentPackSkill {
  slug: string;
  description: string;
}

export interface ResidentPackEntry {
  /** The source id this pack was discovered under (provenance). */
  source_id: string;
  name: string;
  version: string;
  /** Schema pack the pack targets (null when it declares none). */
  schema_pack: string | null;
  /** The brain's active schema pack for THIS source (server-computed, #7). */
  active_schema_pack: string | null;
  /** true/false when the pack declares a schema_pack; null when it doesn't. */
  schema_pack_match: boolean | null;
  skills: ResidentPackSkill[];
  /**
   * Git-source spec a thin client can `gbrain skillpack scaffold <spec>` on its
   * OWN machine. Null when the source has no git remote (local-only source —
   * the thin client cannot install it remotely; binary install is PR2 work).
   */
  scaffold_spec: string | null;
  /** Whether this pack is already scaffolded at this exact version. */
  installed: boolean;
}

export interface ResidentPackResult {
  packs: ResidentPackEntry[];
}

/**
 * Derive a stable brain-id for a source from its canonical git remote (the repo
 * carrying the pack) when available; else a deterministic hash of the canonical
 * local path. NOT the brain DB identity (a different axis). Shared by the
 * Topology-A nag hook and any server-side discovery that needs the same key.
 */
export function deriveBrainId(remoteUrl: string | null | undefined, localPath: string | null | undefined): string {
  if (remoteUrl && remoteUrl.length > 0) return `git:${remoteUrl}`;
  const p = localPath ?? '';
  return `path:${createHash('sha256').update(p).digest('hex').slice(0, 16)}`;
}

function readSkillDescription(packRoot: string, skillDir: string): string {
  const skillMd = join(packRoot, skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return '(no description)';
  try {
    const desc = coerceFrontmatterString(
      parseMarkdown(readFileSync(skillMd, 'utf-8'), skillMd).frontmatter.description,
    );
    return desc && desc.length > 0 ? desc : '(no description)';
  } catch {
    return '(no description)';
  }
}

/**
 * Source-aware active schema pack for the mismatch check (#7): per-source DB
 * config wins, then brain-wide, then the 'gbrain-base' default. Read-only.
 */
async function activeSchemaPackForSource(engine: BrainEngine, sourceId: string): Promise<string> {
  try {
    const perSource = await engine.getConfig(`schema_pack.source.${sourceId}`);
    if (perSource && perSource.length > 0) return perSource;
  } catch {
    /* ignore */
  }
  try {
    const brainWide = await engine.getConfig('schema_pack');
    if (brainWide && brainWide.length > 0) return brainWide;
  } catch {
    /* ignore */
  }
  return 'gbrain-base';
}

/**
 * Enumerate brain-resident packs across the sources in scope for this caller.
 * Fail-open per source: a malformed/absent pack on one source never aborts the
 * whole listing. Returns one entry per in-scope source that ships a
 * `brain_resident: true` pack.
 */
export async function loadResidentPacksForServer(ctx: OperationContext): Promise<ResidentPackResult> {
  const scope = sourceScopeOpts(ctx);
  const allowed: Set<string> | null = scope.sourceIds
    ? new Set(scope.sourceIds)
    : scope.sourceId
      ? new Set([scope.sourceId])
      : null; // null = owner, all sources

  let sources;
  try {
    sources = await loadAllSources(ctx.engine);
  } catch {
    return { packs: [] };
  }

  const state = loadState();
  const packs: ResidentPackEntry[] = [];

  for (const src of sources) {
    if (allowed && !allowed.has(src.id)) continue;
    const localPath = src.local_path;
    if (!localPath || !existsSync(join(localPath, 'skillpack.json'))) continue;
    try {
      const manifest = loadSkillpackManifest(localPath);
      if (manifest.brain_resident !== true) continue;

      const active = await activeSchemaPackForSource(ctx.engine, src.id);
      const wantSchema = manifest.schema_pack ?? null;
      const stateEntry = findEntry(state, manifest.name);
      const remoteUrl = (src.config as Record<string, unknown>)?.remote_url as string | undefined;

      packs.push({
        source_id: src.id,
        name: manifest.name,
        version: manifest.version,
        schema_pack: wantSchema,
        active_schema_pack: active,
        schema_pack_match: wantSchema === null ? null : wantSchema === active,
        skills: manifest.skills.map((s) => ({
          slug: s.replace(/^skills\//, ''),
          description: readSkillDescription(localPath, s),
        })),
        scaffold_spec: remoteUrl && remoteUrl.length > 0 ? remoteUrl : null,
        installed: !!stateEntry && stateEntry.version === manifest.version,
      });
    } catch {
      continue; // malformed pack on this source → skip, keep going
    }
  }

  return { packs };
}

export interface ResidentSkillDetail {
  source_id: string;
  pack_name: string;
  slug: string;
  description: string;
  /** Full SKILL.md body (size-capped). */
  body: string;
}

/**
 * Fetch one brain-resident skill's SKILL.md body from a specific source, for
 * `get_skill` when a `source_id` is supplied (disambiguates a slug that exists
 * on more than one source). Same confinement as skill-catalog: realpath +
 * relative-contained to the pack root, regular file named SKILL.md, size-capped.
 *
 * Throws OperationError (not_found / storage_error) on any miss so the MCP
 * dispatcher surfaces a structured error.
 */
export async function getResidentSkillDetail(
  ctx: OperationContext,
  sourceId: string,
  slug: string,
): Promise<ResidentSkillDetail> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new OperationError('invalid_params', `Invalid skill slug: ${JSON.stringify(slug)}`);
  }
  // Respect source scoping: a scoped caller can only reach its own sources.
  const scope = sourceScopeOpts(ctx);
  if (scope.sourceIds && !scope.sourceIds.includes(sourceId)) {
    throw new OperationError('not_found', `Source not in scope: ${sourceId}`);
  }
  if (scope.sourceId && scope.sourceId !== sourceId) {
    throw new OperationError('not_found', `Source not in scope: ${sourceId}`);
  }

  let sources;
  try {
    sources = await loadAllSources(ctx.engine);
  } catch {
    throw new OperationError('storage_error', 'Could not enumerate sources.');
  }
  const src = sources.find((s) => s.id === sourceId);
  if (!src || !src.local_path) {
    throw new OperationError('not_found', `Source ${sourceId} has no local path.`);
  }
  const packRoot = src.local_path;
  let manifest;
  try {
    manifest = loadSkillpackManifest(packRoot);
  } catch {
    throw new OperationError('not_found', `Source ${sourceId} has no valid skillpack.`);
  }
  if (manifest.brain_resident !== true) {
    throw new OperationError('not_found', `Source ${sourceId} does not ship a brain-resident pack.`);
  }
  const skillDir = `skills/${slug}`;
  if (!manifest.skills.includes(skillDir)) {
    throw new OperationError('not_found', `Skill "${slug}" not in pack ${manifest.name}.`);
  }

  // Confinement: realpath the resolved SKILL.md and require it stays under the
  // realpath'd pack root (defeats symlink/.. escape, including a poisoned pack).
  const skillMd = join(packRoot, skillDir, 'SKILL.md');
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(packRoot);
    realFile = realpathSync(skillMd);
  } catch {
    throw new OperationError('not_found', `SKILL.md missing for ${slug} in ${sourceId}.`);
  }
  const rel = relative(realRoot, realFile);
  if (rel.startsWith('..') || resolve(realRoot, rel) !== realFile) {
    throw new OperationError('storage_error', 'Skill path escaped the pack root.');
  }
  const st = statSync(realFile);
  if (!st.isFile()) throw new OperationError('storage_error', 'Resolved skill path is not a file.');
  if (st.size > MAX_SKILL_MD_BYTES) {
    throw new OperationError('storage_error', `SKILL.md exceeds ${MAX_SKILL_MD_BYTES} bytes.`);
  }

  const body = readFileSync(realFile, 'utf-8');
  return {
    source_id: sourceId,
    pack_name: manifest.name,
    slug,
    description: readSkillDescription(packRoot, skillDir),
    body,
  };
}
