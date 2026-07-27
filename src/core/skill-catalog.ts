/**
 * skill-catalog.ts — host-repo skill catalog for the MCP `list_skills` /
 * `get_skill` ops (PR1).
 *
 * WHAT THIS IS: the agent repo (OpenClaw/Hermes) ships fat-markdown "skills" —
 * prose instruction sets, NOT executable code. This module reads them off the
 * server host's filesystem and shapes them for a thin MCP client (Codex desktop,
 * Claude Code, Perplexity) to discover and FOLLOW. "Using" a skill = fetching its
 * prose and then calling the gbrain MCP tools the same server already exposes.
 *
 * TRUST-BOUNDARY MEMO (read before changing scope/localOnly on the ops):
 * These ops read the server-host filesystem and return file CONTENTS over HTTP.
 * gbrain treats `file_list`/`file_url` as `admin + localOnly` for exactly this
 * reason. `read` + non-localOnly is defensible HERE, but ONLY because of the full
 * mitigation stack — do not weaken one piece without re-reading the rest:
 *   1. Explicit owner opt-in — the publish gate (`mcp.publish_skills`) defaults
 *      OFF at runtime; new installs turn it on at `gbrain init`, existing installs
 *      via a consenting migration. Unlike `file_list`, this is content the owner
 *      deliberately published.
 *   2. Confinement — only the resolved skills dir is reachable. The client `name`
 *      is a manifest LOOKUP KEY, never a raw path segment; the manifest-derived
 *      path is realpath + relative-contained on every call (defeats symlink/`..`
 *      escape, including a poisoned manifest.json `path`); resolved path must be a
 *      regular file named `SKILL.md`.
 *   3. Field allowlist — frontmatter is projected to a safe subset; `writes_to`
 *      (private brain taxonomy) and `sources` (absolute paths) are dropped.
 *   4. Prose-only + size-capped — no source code (PR2 ships tarballs); `get_skill`
 *      caps the file size so a huge/binary file can't OOM the server.
 *   5. No install_path serve for remote — a hosted gbrain with no agent repo
 *      returns `storage_error`, never gbrain's own bundled dev skills.
 *   6. Bounded — the MCP rate limiter caps call rate; per-call memory is bounded
 *      by the size cap.
 *
 * Skills live on the HOST FILESYSTEM and are repo-global: `sourceScopeOpts(ctx)` /
 * `ctx.sourceId` (in-DB tenancy) and `ctx.brainId` (mounts) deliberately do NOT
 * apply. One server host = one skills dir = one catalog for all callers.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import {
  autoDetectSkillsDir,
  autoDetectSkillsDirReadOnly,
  AUTO_DETECT_HINT,
  AUTO_DETECT_HINT_READ_ONLY,
  type SkillsDirSource,
} from './repo-root.ts';
import { loadOrDeriveManifest, type ManifestEntry } from './skill-manifest.ts';
import { loadSkillTriggerIndex, FRONTMATTER_SECTION } from './skill-trigger-index.ts';
import { parseSkillFrontmatter } from './skill-frontmatter.ts';
import { hasScope } from './scope.ts';
import { operations, OperationError, type Operation, type OperationContext } from './operations.ts';
import {
  SKILL_CATALOG_INSTRUCTIONS,
  SKILL_CLIENT_GUIDANCE,
} from './operations-descriptions.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max SKILL.md size `get_skill` will read/return. Env-overridable. Default
 *  256 KB — generous for prose, small enough that a stray binary/generated file
 *  can't balloon the server's RSS (codex P1-c). */
export const MAX_SKILL_MD_BYTES = (() => {
  const raw = process.env.GBRAIN_MAX_SKILL_MD_BYTES;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 256 * 1024;
})();

/** Max client-supplied skill name length before we even hit the manifest. */
const MAX_SKILL_NAME_LEN = 128;

/** Where auto-detect found the dir, plus the explicit-config variant. */
export type ResolvedSkillsDirSource = SkillsDirSource | 'config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillCatalogEntry {
  name: string;
  description: string;
  section: string;
  triggers: string[];
  tools: string[];
  /** declared tools ∩ (exposed by this server AND permitted to this caller). */
  usable_tools: string[];
  /** declared tools − usable (not on this server, or beyond caller scope). */
  unavailable_tools: string[];
  writes_pages: boolean;
  mutating: boolean;
}

export interface ListSkillsResult {
  schema_version: 1;
  skills_dir_source: ResolvedSkillsDirSource;
  count: number;
  skills: SkillCatalogEntry[];
  instructions: {
    summary: string;
    how_to_use: string[];
    available_brain_tools: string[];
    fetch_op: 'get_skill';
  };
}

export interface GetSkillResult {
  schema_version: 1;
  name: string;
  /** Allowlisted projection — never the raw frontmatter object. */
  frontmatter: {
    name?: string;
    description?: string;
    triggers?: string[];
    tools?: string[];
    writes_pages?: boolean;
    mutating?: boolean;
  };
  body: string;
  usable_tools: string[];
  unavailable_tools: string[];
  client_guidance: {
    nature: string;
    protocol: string[];
    available_brain_tools: string[];
    mutating: boolean;
  };
}

// ---------------------------------------------------------------------------
// Skills-dir resolution
// ---------------------------------------------------------------------------

/**
 * Read `mcp.publish_skills` honoring BOTH config planes. `gbrain config set`
 * writes the DB plane (engine.setConfig) — so the DB value wins; `gbrain init`
 * also writes the DB plane. The file plane (`config.json` → `ctx.config.mcp`) is
 * a fallback for hand-edited configs. Absent in both → false (fail-safe).
 */
export async function readMcpPublishSkills(ctx: OperationContext): Promise<boolean> {
  let dbVal: string | null = null;
  try {
    dbVal = await ctx.engine.getConfig('mcp.publish_skills');
  } catch {
    // Engine without a config table / transient error → fall back to file plane.
  }
  if (dbVal != null) return dbVal === 'true';
  return ctx.config?.mcp?.publish_skills === true;
}

/**
 * Read `mcp.skills_dir` from the DB plane (what `gbrain config set` writes),
 * falling back to the file plane. Returns undefined when unset on both.
 */
export async function readMcpSkillsDir(ctx: OperationContext): Promise<string | undefined> {
  let dbVal: string | null = null;
  try {
    dbVal = await ctx.engine.getConfig('mcp.skills_dir');
  } catch {
    // ignore — fall through to file plane
  }
  if (dbVal && dbVal.trim().length > 0) return dbVal;
  const fileVal = ctx.config?.mcp?.skills_dir;
  return fileVal && fileVal.trim().length > 0 ? fileVal : undefined;
}

/**
 * Resolve the skills dir for this call. An explicit `mcp.skills_dir` override
 * (resolved from either config plane by the caller) wins; otherwise autodetect.
 * REMOTE callers use `autoDetectSkillsDir` (no install_path tier — a hosted
 * gbrain must never serve its own bundled dev skills); LOCAL callers
 * (`ctx.remote === false`) use the read-only variant with the install_path
 * fallback. Throws `storage_error` (with the search-path hint) when nothing
 * resolves. Pure modulo filesystem state — `skillsDirOverride` keeps it testable
 * without an engine.
 */
export function resolveSkillsDir(
  ctx: OperationContext,
  skillsDirOverride?: string,
): {
  dir: string;
  source: ResolvedSkillsDirSource;
} {
  if (skillsDirOverride && skillsDirOverride.trim().length > 0) {
    if (!existsSync(skillsDirOverride)) {
      throw new OperationError(
        'storage_error',
        `Configured mcp.skills_dir does not exist: ${skillsDirOverride}`,
        'Fix it with `gbrain config set mcp.skills_dir <path>` or unset it to autodetect.',
      );
    }
    return { dir: skillsDirOverride, source: 'config' };
  }

  const det =
    ctx.remote === false ? autoDetectSkillsDirReadOnly() : autoDetectSkillsDir();
  if (!det.dir || !det.source) {
    const hint = ctx.remote === false ? AUTO_DETECT_HINT_READ_ONLY : AUTO_DETECT_HINT;
    throw new OperationError(
      'storage_error',
      'No skills directory found on the server host.',
      `Set it explicitly: \`gbrain config set mcp.skills_dir <path>\` (or $GBRAIN_SKILLS_DIR). Search order:\n${hint}`,
    );
  }
  return { dir: det.dir, source: det.source };
}

// ---------------------------------------------------------------------------
// Path confinement (the security boundary)
// ---------------------------------------------------------------------------

/** Validate the client-supplied skill name BEFORE any filesystem access. */
function assertSkillNameShape(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new OperationError('invalid_params', 'skill name must be a non-empty string');
  }
  if (name.length > MAX_SKILL_NAME_LEN) {
    throw new OperationError('invalid_params', `skill name exceeds ${MAX_SKILL_NAME_LEN} characters`);
  }
  // No path separators, no traversal, no null byte. The name is a manifest
  // LOOKUP KEY — it must never look like a path component.
  if (/[/\\]|\.\.| /.test(name)) {
    throw new OperationError('invalid_params', `Invalid skill name: ${name}`);
  }
}

/**
 * Resolve `name` → the absolute, confined `SKILL.md` path. The name is resolved
 * THROUGH the vetted manifest (never used as a raw path segment); the
 * manifest-derived path is realpath + relative-contained on every call; the
 * resolved target must be a regular file named `SKILL.md`. Throws on any miss.
 */
export function resolveSkillMdPath(skillsDir: string, name: string): string {
  assertSkillNameShape(name);
  const { skills } = loadOrDeriveManifest(skillsDir);
  const entry = skills.find(s => s.name === name);
  if (!entry) {
    throw new OperationError(
      'page_not_found',
      `Skill not found: ${name}`,
      'Call list_skills to see available skills.',
    );
  }
  return confineManifestPath(skillsDir, entry);
}

/**
 * Realpath + containment + file-type check for a manifest entry's `path`. Used
 * by both `get_skill` (one entry) and `list_skills` (every entry — manifest.json
 * `path` is taken verbatim, so a poisoned entry must not escape). Throws on
 * escape / missing / non-`SKILL.md` / non-regular-file.
 */
export function confineManifestPath(skillsDir: string, entry: ManifestEntry): string {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync(skillsDir);
  } catch {
    throw new OperationError('storage_error', `Cannot resolve skills dir: ${skillsDir}`);
  }
  const candidate = join(realRoot, entry.path);
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    throw new OperationError('page_not_found', `Skill file not found: ${entry.name}`);
  }
  const rel = relative(realRoot, realCandidate);
  if (rel.startsWith('..') || resolve(realRoot, rel) !== realCandidate) {
    throw new OperationError('invalid_params', `Skill path escapes skills dir: ${entry.name}`);
  }
  let st;
  try {
    st = statSync(realCandidate);
  } catch {
    throw new OperationError('page_not_found', `Skill file not found: ${entry.name}`);
  }
  if (!st.isFile() || basename(realCandidate) !== 'SKILL.md') {
    throw new OperationError(
      'invalid_params',
      `Skill target is not a SKILL.md regular file: ${entry.name}`,
    );
  }
  return realCandidate;
}

// ---------------------------------------------------------------------------
// Tool honesty (D7)
// ---------------------------------------------------------------------------

/** Can THIS caller call THIS op on THIS server? Local owns everything. */
function opCallableByCaller(op: Operation, ctx: OperationContext): boolean {
  if (ctx.remote === false) return true; // local CLI — OS is the trust boundary
  if (op.localOnly) return false; // not reachable over a remote transport
  return hasScope(ctx.auth?.scopes ?? [], op.scope ?? 'read');
}

/**
 * Split a skill's declared `tools:` into what the caller can vs cannot actually
 * use, cross-referenced against this server's op set AND the caller's scope.
 * A declared tool not in the op set is unavailable (not on this server).
 */
export function crossReferenceTools(
  declared: string[],
  ctx: OperationContext,
): { usable_tools: string[]; unavailable_tools: string[] } {
  const usable: string[] = [];
  const unavailable: string[] = [];
  for (const tool of declared) {
    const op = operations.find(o => o.name === tool);
    if (op && opCallableByCaller(op, ctx)) usable.push(tool);
    else unavailable.push(tool);
  }
  return { usable_tools: usable, unavailable_tools: unavailable };
}

/** Every server tool this caller can call — the envelope's "what you can use". */
function availableBrainTools(ctx: OperationContext): string[] {
  return operations.filter(op => opCallableByCaller(op, ctx)).map(op => op.name).sort();
}

// ---------------------------------------------------------------------------
// Frontmatter projection + description
// ---------------------------------------------------------------------------

/**
 * Parse a `description:` from raw frontmatter (best-effort).
 *
 * #1711: handles YAML block scalars. `description: |` (literal) and
 * `description: >` (folded), with optional chomping/indent indicators
 * (`|-`, `>+`, `|2`), are parsed by reading the following indented lines and
 * folding them into a single line for the one-line catalog. Pre-fix the regex
 * captured the bare `|`/`>` indicator as the description, so block-scalar skills
 * showed a literal "|" in the catalog instead of their text.
 */
function parseDescriptionField(raw: string): string | undefined {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^description:[ \t]*(.*)$/);
    if (!m) continue;
    const inline = m[1].trim();

    // Block scalar indicator (`|`, `>`, with optional chomp `+`/`-` and indent digit).
    if (/^[|>][+-]?\d*$/.test(inline)) {
      const block: string[] = [];
      let baseIndent: number | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim().length === 0) { block.push(''); continue; }
        const indent = line.length - line.trimStart().length;
        if (baseIndent === null) {
          if (indent === 0) break;   // no indented continuation
          baseIndent = indent;
        }
        if (indent < baseIndent) break;  // dedent ends the block
        block.push(line.slice(baseIndent));
      }
      // Catalog descriptions are one line; collapse literal/folded whitespace.
      const folded = block.join(' ').replace(/\s+/g, ' ').trim();
      return folded.length > 0 ? folded : undefined;
    }

    // Inline scalar: strip a matching pair of surrounding quotes.
    const unq = inline.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    return unq.length > 0 ? unq : undefined;
  }
  return undefined;
}

/** Strip the leading `---\n...\n---` fence; return the prose body. */
function stripFrontmatterFence(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? content.slice(m[0].length) : content;
}

/** First non-empty, non-heading prose line of the body (description fallback). */
function firstProseLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('<!--')) continue;
    return t.replace(/^[*_>`-]+\s*/, '').trim();
  }
  return '';
}

/** description = frontmatter `description:` or first prose line, else ''. */
export function oneLineDescription(raw: string, body: string): string {
  return parseDescriptionField(raw) ?? firstProseLine(body);
}

// ---------------------------------------------------------------------------
// Catalog assembly
// ---------------------------------------------------------------------------

interface TriggerInfo {
  triggers: Set<string>;
  section: string;
}

/** Group the unified trigger index by skill directory name. */
function buildTriggerMap(skillsDir: string): Map<string, TriggerInfo> {
  const map = new Map<string, TriggerInfo>();
  for (const e of loadSkillTriggerIndex(skillsDir)) {
    if (e.isGStack) continue; // external refs aren't fetchable skills
    const m = e.skillPath.match(/^skills\/([^/]+)\//);
    if (!m) continue;
    const dir = m[1];
    let info = map.get(dir);
    if (!info) {
      info = { triggers: new Set(), section: e.section };
      map.set(dir, info);
    }
    info.triggers.add(e.trigger);
    // Prefer a real RESOLVER.md section label over the synthesized
    // frontmatter section when both exist.
    if (info.section === FRONTMATTER_SECTION && e.section !== FRONTMATTER_SECTION) {
      info.section = e.section;
    }
  }
  return map;
}

/** First path segment of a manifest entry path (the skill dir name). */
function dirNameOf(entry: ManifestEntry): string {
  return entry.path.split('/')[0] ?? entry.name;
}

/**
 * Build the flat host-repo skill catalog + the instructional envelope. Resilient:
 * a single malformed/escaping skill is skipped, never throws the whole call.
 */
export function buildSkillCatalog(
  ctx: OperationContext,
  skillsDir: string,
  source: ResolvedSkillsDirSource,
  opts: { section?: string } = {},
): ListSkillsResult {
  const { skills: manifest } = loadOrDeriveManifest(skillsDir);
  const triggerMap = buildTriggerMap(skillsDir);
  const sectionFilter = opts.section?.trim();

  const skills: SkillCatalogEntry[] = [];
  for (const entry of manifest) {
    let path: string;
    try {
      path = confineManifestPath(skillsDir, entry);
    } catch {
      continue; // skip escaping / non-SKILL.md / missing entries in the listing
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseSkillFrontmatter(content);
    const raw = parsed?.raw ?? '';
    const body = stripFrontmatterFence(content);
    const dir = dirNameOf(entry);
    const trig = triggerMap.get(dir);
    const triggers = trig
      ? Array.from(trig.triggers)
      : parsed?.triggers ?? [];
    const section = trig?.section ?? FRONTMATTER_SECTION;

    if (sectionFilter && section !== sectionFilter) continue;

    const tools = parsed?.tools ?? [];
    const { usable_tools, unavailable_tools } = crossReferenceTools(tools, ctx);
    skills.push({
      name: entry.name,
      description: oneLineDescription(raw, body),
      section,
      triggers,
      tools,
      usable_tools,
      unavailable_tools,
      writes_pages: parsed?.writes_pages ?? false,
      mutating: parsed?.mutating ?? false,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));

  return {
    schema_version: 1,
    skills_dir_source: source,
    count: skills.length,
    skills,
    instructions: {
      summary: SKILL_CATALOG_INSTRUCTIONS.summary,
      how_to_use: [...SKILL_CATALOG_INSTRUCTIONS.how_to_use],
      available_brain_tools: availableBrainTools(ctx),
      fetch_op: 'get_skill',
    },
  };
}

/** Fetch one skill's full instructions (prose only, size-capped, sanitized). */
export function getSkillDetail(
  ctx: OperationContext,
  skillsDir: string,
  name: string,
): GetSkillResult {
  const path = resolveSkillMdPath(skillsDir, name);

  const size = statSync(path).size;
  if (size > MAX_SKILL_MD_BYTES) {
    throw new OperationError(
      'payload_too_large',
      `Skill ${name} is ${size} bytes (cap ${MAX_SKILL_MD_BYTES}).`,
      'Raise GBRAIN_MAX_SKILL_MD_BYTES if this is a legitimately large skill.',
    );
  }
  const content = readFileSync(path, 'utf-8');
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_MD_BYTES) {
    throw new OperationError('payload_too_large', `Skill ${name} exceeds the size cap.`);
  }

  const parsed = parseSkillFrontmatter(content);
  const raw = parsed?.raw ?? '';
  const body = stripFrontmatterFence(content);
  const tools = parsed?.tools ?? [];
  const { usable_tools, unavailable_tools } = crossReferenceTools(tools, ctx);
  const mutating = parsed?.mutating ?? false;

  return {
    schema_version: 1,
    name,
    frontmatter: {
      name: parsed?.name,
      description: oneLineDescription(raw, body) || undefined,
      triggers: parsed?.triggers,
      tools: parsed?.tools,
      writes_pages: parsed?.writes_pages,
      mutating: parsed?.mutating,
    },
    body,
    usable_tools,
    unavailable_tools,
    client_guidance: {
      nature: SKILL_CLIENT_GUIDANCE.nature,
      protocol: [...SKILL_CLIENT_GUIDANCE.protocol],
      available_brain_tools: availableBrainTools(ctx),
      mutating,
    },
  };
}

// ---------------------------------------------------------------------------
// Publish gate
// ---------------------------------------------------------------------------

/**
 * Enforce the publish gate. Local callers (`ctx.remote === false`) always pass —
 * the owner running the CLI owns the machine. Remote callers require
 * `publishSkills === true` (resolved from either config plane by the caller;
 * absent → false → OFF, fail-safe: no silent capability grant to existing tokens
 * on upgrade). Throws `permission_denied` otherwise. Pure (boolean in) so tests
 * drive both branches without an engine.
 */
export function assertPublishEnabled(ctx: OperationContext, publishSkills: boolean): void {
  if (ctx.remote === false) return;
  if (publishSkills) return;
  throw new OperationError(
    'permission_denied',
    'Skill publishing is disabled by the brain owner.',
    'The owner can enable it with `gbrain config set mcp.publish_skills true`.',
  );
}
