/**
 * Render engine for `gbrain bootstrap render` (library module — the dispatcher
 * in src/commands/bootstrap/ calls `renderWorkspace`).
 *
 * One rendering code path, two consumers [D4]: the normal bootstrap render
 * (interview answers) and the release-time template-repo generator
 * (`minimal: true`, placeholder answers, byte-deterministic [CX2-14]).
 *
 * Contracts carried from docs/designs/AGENT_BOOTSTRAP_PLAN.md:
 *  - Token resolution: interview answers > bank defaults. DERIVED_TOKENS
 *    (assets.ts) resolve from `opts.derived` with canonical fallbacks.
 *  - [S3#3] Interview-sourced values are DATA, not structure: before
 *    insertion, any line of an answer that begins (allowing up to 3 leading
 *    spaces, the markdown heading tolerance) with `#`, `<!--`, a ``` code
 *    fence, or a ~~~ tilde fence is prefixed with a backslash — THE
 *    DOCUMENTED ESCAPE. A
 *    backslash-prefixed `#` is not a heading, `\<!--` is not a comment
 *    open, and `\``` does not open a fence. The first line of a value is
 *    escaped too even when the token sits mid-line — deliberate
 *    over-escaping; a cosmetic backslash beats a structural injection.
 *    Values already carry set-time `{{`/`}}` escaping (interview.ts), so
 *    substitution can never introduce new tokens.
 *  - HARD-FAIL on any unresolved {{TOKEN}} — every unresolved token across
 *    every selected file is listed, and NOTHING is written (all files render
 *    in memory first).
 *  - Render never clobbers: an existing dest without `force` is skipped;
 *    with `force` the old content is backed up to
 *    `<ws>/.gbrain-bootstrap-backups/<ts>/<dest>` before the write.
 *  - Minimal mode [D4/CX2-14]: ignores interview state AND `opts.derived`
 *    entirely; keys with bank defaults render their defaults; the six
 *    required keys (no defaults) stay as literal `{{TOKEN}}` placeholders
 *    (they are the template repo's visible fill-me markers); the manifest is
 *    the canonical TEMPLATE_PLACEHOLDER_MANIFEST (frozen timestamp). Two
 *    independent minimal renders are byte-identical.
 *  - [ENG-10] The renderer only ever writes BOOTSTRAP_TEMPLATES dests —
 *    never skillpack scaffold paths, so intentional literals like
 *    `{{output-from-skill}}` in skills/ survive untouched. Guarded by
 *    `isBootstrapRenderDest` at write time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BOOTSTRAP_TEMPLATES, DERIVED_TOKENS, GITHUB_URL_PLACEHOLDER, loadQuestionBank, readTemplate } from './assets.ts';
import {
  readManifest,
  writeManifest,
  FORMAT_VERSION,
  TEMPLATE_PLACEHOLDER_MANIFEST,
  type AgentManifest,
} from './format.ts';
import { readInterviewState, type InterviewState } from './interview.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BootstrapRenderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BootstrapRenderError';
    this.code = code;
  }
}

export class UnresolvedTokenError extends BootstrapRenderError {
  tokens: string[];
  constructor(tokens: string[]) {
    super(
      'unresolved_tokens',
      `render refused — unresolved template tokens (nothing was written): ${tokens.join(', ')}. ` +
        `Answer the missing interview questions (gbrain bootstrap interview --status) and re-run.`
    );
    this.name = 'UnresolvedTokenError';
    this.tokens = tokens;
  }
}

// ---------------------------------------------------------------------------
// Public option/result types
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Overwrite existing dests (each overwritten file is backed up first). */
  force?: boolean;
  /** Render only these dests (exact BOOTSTRAP_TEMPLATES dest names, e.g.
   * ['SOUL.md']). Unknown names throw. Partial renders never touch the
   * manifest (a `render --only` on a template clone must not flip it to
   * initialized). */
  only?: string[];
  /** Template-repo generator mode [D4]: all defaults, byte-deterministic. */
  minimal?: boolean;
  /** Values for DERIVED_TOKENS (GITHUB_REPO_URL, CORPUS_RETENTION_DAYS).
   * Ignored in minimal mode (determinism). Missing entries use canonical
   * fallbacks. */
  derived?: Record<string, string>;
  /** Recorded as agent.json `created_by` (the dispatcher passes the gbrain
   * version). */
  createdBy?: string;
  /** Recorded as agent.json `source_id`. When unset, an existing initialized
   * manifest's source_id is preserved; otherwise defaults to 'workspace'. */
  sourceId?: string;
}

export interface RenderResult {
  written: string[];
  skipped: string[];
  backups: string[];
}

/** Canonical fallbacks for DERIVED_TOKENS — also the exact values minimal
 * mode always uses [CX2-14]. */
export const DERIVED_DEFAULTS: Record<(typeof DERIVED_TOKENS)[number], string> = {
  GITHUB_REPO_URL: GITHUB_URL_PLACEHOLDER,
  CORPUS_RETENTION_DAYS: '30',
};

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

// ---------------------------------------------------------------------------
// Building blocks (exported for direct unit tests)
// ---------------------------------------------------------------------------

/** [ENG-10] The only paths the renderer may ever write, relative to the
 * workspace root. Skillpack scaffolds, skills/, and anything else are out. */
export function isBootstrapRenderDest(relPath: string): boolean {
  return BOOTSTRAP_TEMPLATES.some((t) => t.dest === relPath);
}

/**
 * [S3#3] Structural-marker escape for interview-sourced values (see module
 * doc). Applied at render time, per line, to answer values only — bank
 * defaults are our own trusted copy.
 */
export function escapeStructuralMarkers(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^(\s{0,3})(#|<!--|```|~~~)/, '$1\\$2'))
    .join('\n');
}

/** Collapse runs of 3+ blank lines to exactly 2 (4+ consecutive newlines →
 * 3). Applied to final rendered content, so empty optional answers don't
 * leave gaping holes. */
export function collapseBlankLines(content: string): string {
  return content.replace(/\n{4,}/g, '\n\n\n');
}

/**
 * Byte floors for `bootstrap verify`, scaled to how many interview questions
 * were actually answered. Floors catch SKIPPED INTERVIEWS, never pressure
 * invention: an all-defaults render passes the base floor; every answered
 * question raises the bar toward the full-interview floor (D8: SOUL.md
 * ≥3000B, USER.md ≥1000B at all 12 answered).
 *
 * Formula (documented contract):
 *   SOUL.md floor = 1500 + 125 × min(answeredCount, 12)
 *   USER.md floor =  400 +  50 × min(answeredCount, 12)
 */
export function byteFloors(answeredCount: number): { 'SOUL.md': number; 'USER.md': number } {
  const n = Math.max(0, Math.min(Math.floor(answeredCount), 12));
  return {
    'SOUL.md': 1500 + 125 * n,
    'USER.md': 400 + 50 * n,
  };
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

type Resolution =
  | { kind: 'value'; value: string }
  /** Minimal mode, key with no default: the literal token stays in the file
   * on purpose (template-repo fill-me marker) and is NOT an error. */
  | { kind: 'placeholder' }
  | { kind: 'unresolved' };

function buildResolver(opts: RenderOptions, state: InterviewState | null): (token: string) => Resolution {
  const bank = loadQuestionBank();
  const minimal = opts.minimal === true;
  const derivedSet = new Set<string>(DERIVED_TOKENS);

  return (token: string): Resolution => {
    if (derivedSet.has(token)) {
      const canonical = DERIVED_DEFAULTS[token as (typeof DERIVED_TOKENS)[number]];
      if (minimal) return { kind: 'value', value: canonical };
      const supplied = opts.derived?.[token];
      return { kind: 'value', value: supplied !== undefined ? supplied : canonical };
    }
    const spec = bank.questions[token];
    if (!spec) return { kind: 'unresolved' };
    if (!minimal && state) {
      const a = state.answers[token];
      if (a && a.skipped !== true) {
        return { kind: 'value', value: escapeStructuralMarkers(a.value) };
      }
    }
    if (spec.default !== undefined) return { kind: 'value', value: spec.default };
    if (minimal) return { kind: 'placeholder' };
    return { kind: 'unresolved' };
  };
}

// ---------------------------------------------------------------------------
// renderWorkspace
// ---------------------------------------------------------------------------

export function renderWorkspace(workspaceDir: string, opts: RenderOptions = {}): RenderResult {
  const minimal = opts.minimal === true;

  // Minimal mode is the template-repo generator path: it lays placeholder
  // content AND resets the manifest to `initialized: false`. On a LIVE
  // (initialized) workspace that would demote a real install to a template
  // clone — refuse unless the caller forces it (typed error, agent-readable).
  if (minimal && !opts.force) {
    const existing = readManifest(workspaceDir);
    if (existing.state === 'initialized') {
      throw new BootstrapRenderError(
        'minimal_on_initialized',
        'render --minimal refused: this workspace is already initialized (agent.json says initialized: true). ' +
          'Minimal mode writes template placeholders and resets the manifest to an uninitialized template. ' +
          'If you really mean to, re-run with --force (existing files are backed up first).'
      );
    }
  }

  // Validate --only against the known dest list (typo protection).
  const selected = BOOTSTRAP_TEMPLATES.filter((t) => !opts.only || opts.only.includes(t.dest));
  if (opts.only) {
    const known = new Set(BOOTSTRAP_TEMPLATES.map((t) => t.dest));
    const unknown = opts.only.filter((o) => !known.has(o));
    if (unknown.length > 0) {
      throw new BootstrapRenderError(
        'unknown_only',
        `unknown render target(s): ${unknown.join(', ')}. Valid targets: ${[...known].join(', ')}.`
      );
    }
  }

  // Interview state feeds tokens only in non-minimal mode. A broken state
  // file (conflict markers, invalid JSON) surfaces as an agent-readable
  // error, never a SyntaxError [G12].
  let state: InterviewState | null = null;
  if (!minimal) {
    const read = readInterviewState(workspaceDir);
    if (!read.ok) throw new BootstrapRenderError(read.code, read.message);
    state = read.state;
  }

  const resolve = buildResolver(opts, state);

  // Phase 1 — render everything in memory. Nothing is written until every
  // selected file resolves cleanly (hard-fail lists ALL unresolved tokens).
  const unresolved = new Set<string>();
  const placeholders = new Set<string>();
  const rendered: Array<{ dest: string; content: string }> = [];

  for (const t of selected) {
    const template = readTemplate(t);
    // Function-form replace: replacement values are inserted verbatim —
    // `$&`-style patterns in an answer are never re-interpreted, and
    // set-time escaping guarantees a value cannot introduce a new token.
    const out = template.replace(TOKEN_RE, (match, token: string) => {
      const r = resolve(token);
      if (r.kind === 'value') return r.value;
      if (r.kind === 'placeholder') {
        placeholders.add(token);
        return match;
      }
      unresolved.add(token);
      return match;
    });
    // Defensive final sweep: any surviving token that is not a deliberate
    // minimal-mode placeholder is unresolved.
    for (const m of out.matchAll(TOKEN_RE)) {
      const token = m[1]!;
      if (!placeholders.has(token)) unresolved.add(token);
    }
    rendered.push({ dest: t.dest, content: collapseBlankLines(out) });
  }

  if (unresolved.size > 0) {
    throw new UnresolvedTokenError([...unresolved].sort());
  }

  // Phase 2 — write, never clobbering without force [plan: render never
  // clobbers]. Backups for a forced overwrite land under one per-run
  // timestamp dir.
  const result: RenderResult = { written: [], skipped: [], backups: [] };
  const backupStamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const { dest, content } of rendered) {
    if (!isBootstrapRenderDest(dest)) {
      // [ENG-10] Unreachable by construction (dests come from
      // BOOTSTRAP_TEMPLATES), kept as the write-time guard so a future
      // refactor can never point the renderer at scaffold paths.
      throw new BootstrapRenderError('forbidden_dest', `refusing to render non-bootstrap path: ${dest}`);
    }
    const abs = join(workspaceDir, dest);
    if (existsSync(abs)) {
      if (!opts.force) {
        result.skipped.push(dest);
        continue;
      }
      const backupAbs = join(workspaceDir, '.gbrain-bootstrap-backups', backupStamp, dest);
      mkdirSync(dirname(backupAbs), { recursive: true });
      writeFileSync(backupAbs, readFileSync(abs), { flag: 'wx' });
      result.backups.push(join('.gbrain-bootstrap-backups', backupStamp, dest));
    }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, abs);
    result.written.push(dest);
  }

  // Phase 3 — manifest. Full renders only: a partial `--only` render must
  // not flip a template clone to initialized (and must not invent a
  // manifest). Minimal mode writes the canonical placeholder manifest
  // (initialized: false, frozen timestamp) for byte determinism [CX2-14].
  if (!opts.only) {
    if (minimal) {
      writeManifest(workspaceDir, TEMPLATE_PLACEHOLDER_MANIFEST);
    } else {
      const existing = readManifest(workspaceDir);
      const priorCreatedAt =
        existing.state === 'initialized' && typeof existing.manifest.created_at === 'string'
          ? existing.manifest.created_at
          : null;
      // Preserve a prior source_id (verify's collision resolution may have
      // derived e.g. 'workspace-<hash>' and persisted it — a re-render must
      // not silently reset it to the default).
      const priorSourceId =
        existing.state === 'initialized' &&
        typeof existing.manifest.source_id === 'string' &&
        existing.manifest.source_id.length > 0
          ? existing.manifest.source_id
          : null;
      const agentName = state?.answers['AGENT_NAME']?.value ?? '{{AGENT_NAME}}';
      const manifest: AgentManifest = {
        format_version: FORMAT_VERSION,
        initialized: true,
        agent_name: agentName,
        created_by: opts.createdBy ?? 'gbrain',
        created_at: priorCreatedAt ?? new Date().toISOString(),
        source_id: opts.sourceId ?? priorSourceId ?? 'workspace',
      };
      writeManifest(workspaceDir, manifest);
    }
  }

  return result;
}
