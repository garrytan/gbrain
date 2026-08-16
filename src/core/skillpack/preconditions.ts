/**
 * skillpack/preconditions.ts — precondition vocabulary + checker.
 *
 * A skill can declare machine-checkable preconditions in its SKILL.md
 * frontmatter via `requires:` (see skill-frontmatter.ts). Each entry is a
 * string `kind` or `kind:arg`. Before a harness runs a skill, it can check
 * these against live brain state and surface a paste-ready remediation hint
 * for any that aren't met — instead of the skill silently no-op'ing on an
 * empty corpus.
 *
 * Vocabulary:
 *   - `source`        — the brain has at least one non-default source with
 *                       >=1 page (a corpus exists).
 *   - `source:<id>`   — a source with that id exists.
 *   - `dir:<path>`    — a brain page-directory (e.g. `conversations/`) has
 *                       >=1 page.
 *   - `config:<key>`  — a config key resolves to a non-empty value.
 *   - `pages:<n>`     — the brain has >= n total pages.
 *
 * Purity / DI seam: this module never imports the engine. The checker takes
 * a narrow `PreconditionContext` of injected functions so it stays
 * pure-testable (mirrors the injected-`chatFn`/`toolLoopFn` deps convention
 * used across src/core, e.g. skillopt/rollout.ts).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Precondition {
  /** The original `requires:` token, verbatim. */
  raw: string;
  /** Parsed precondition kind; `unknown` when the token isn't recognized. */
  kind: 'source' | 'dir' | 'config' | 'pages' | 'unknown';
  /** The `:arg` portion, when present (source id, dir path, config key, count). */
  arg?: string;
}

export interface PreconditionResult {
  /** The parsed precondition being checked. */
  req: Precondition;
  /** Whether the precondition is satisfied by current brain state. */
  met: boolean;
  /** Human-readable statement of what was (or wasn't) found. */
  detail: string;
  /** Paste-ready remediation. Non-empty even when met (says why it passed). */
  hint: string;
}

/**
 * Narrow injected-dependency seam. The caller wires these to the engine (or
 * to fakes, in tests) so this module stays free of engine/fs imports.
 */
export interface PreconditionContext {
  /** Total pages in the brain (across all sources). */
  countPages(): Promise<number>;
  /** Pages filed under a given brain directory prefix (e.g. `conversations/`). */
  countPagesInDir(dir: string): Promise<number>;
  /** Non-default source ids that hold at least one page. */
  listSourceIds(): Promise<string[]>;
  /** Optional: pages for a specific source id. */
  countPagesForSource?(id: string): Promise<number>;
  /** Resolve a config key; undefined/empty means unset. */
  getConfig(key: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const KNOWN_KINDS = new Set<Precondition['kind']>(['source', 'dir', 'config', 'pages']);

/**
 * Parse a single `requires:` token into a {@link Precondition}. The token is
 * split on the FIRST colon only, so args that themselves contain colons
 * (rare config keys) survive intact. Unrecognized kinds parse to
 * `kind: 'unknown'` (the checker fails them with a vocabulary hint).
 */
export function parsePrecondition(raw: string): Precondition {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(':');
  const kindStr = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const arg = colon === -1 ? undefined : trimmed.slice(colon + 1).trim();

  if (KNOWN_KINDS.has(kindStr as Precondition['kind'])) {
    return { raw, kind: kindStr as Precondition['kind'], arg: arg || undefined };
  }
  return { raw, kind: 'unknown', arg: arg || undefined };
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/**
 * Check a list of `requires:` tokens against live brain state via the
 * injected {@link PreconditionContext}. Returns one result per input token,
 * in order. Never throws for an unmet precondition — an unmet precondition is
 * a normal `met: false` result, not an error.
 */
export async function checkPreconditions(
  reqs: string[],
  ctx: PreconditionContext,
): Promise<PreconditionResult[]> {
  const out: PreconditionResult[] = [];
  for (const raw of reqs) {
    const req = parsePrecondition(raw);
    out.push(await checkOne(req, ctx));
  }
  return out;
}

async function checkOne(req: Precondition, ctx: PreconditionContext): Promise<PreconditionResult> {
  switch (req.kind) {
    case 'source':
      return req.arg ? checkSpecificSource(req, ctx) : checkAnySource(req, ctx);
    case 'dir':
      return checkDir(req, ctx);
    case 'config':
      return checkConfig(req, ctx);
    case 'pages':
      return checkPages(req, ctx);
    case 'unknown':
    default:
      return {
        req,
        met: false,
        detail: `unrecognized precondition kind`,
        hint: `unrecognized precondition '${req.raw}' — see skillpack/preconditions.ts vocabulary`,
      };
  }
}

async function checkAnySource(req: Precondition, ctx: PreconditionContext): Promise<PreconditionResult> {
  const ids = await ctx.listSourceIds();
  const met = ids.length > 0;
  return {
    req,
    met,
    detail: met
      ? `found ${ids.length} source(s) with content: ${ids.join(', ')}`
      : `no non-default source holds any pages`,
    hint: met
      ? `corpus present (${ids.length} source(s))`
      : `ingest a corpus first (gbrain sync / gbrain import), then re-run`,
  };
}

async function checkSpecificSource(req: Precondition, ctx: PreconditionContext): Promise<PreconditionResult> {
  const id = req.arg as string;
  const ids = await ctx.listSourceIds();
  const met = ids.includes(id);
  return {
    req,
    met,
    detail: met ? `source '${id}' exists` : `source '${id}' not found (have: ${ids.join(', ') || 'none'})`,
    hint: met
      ? `source '${id}' present`
      : `add or ingest source '${id}' first (gbrain sources add ${id} / gbrain sync --source ${id}), then re-run`,
  };
}

async function checkDir(req: Precondition, ctx: PreconditionContext): Promise<PreconditionResult> {
  const dir = req.arg;
  if (!dir) {
    return {
      req,
      met: false,
      detail: `dir: requires a path argument (e.g. dir:conversations/)`,
      hint: `specify a directory: dir:<path> — see skillpack/preconditions.ts vocabulary`,
    };
  }
  const count = await ctx.countPagesInDir(dir);
  const met = count > 0;
  return {
    req,
    met,
    detail: met ? `${count} page(s) under ${dir}` : `no pages under ${dir}`,
    hint: met
      ? `${dir} populated (${count} page(s))`
      : `populate ${dir} (see the conversation-archive skill), then re-run`,
  };
}

async function checkConfig(req: Precondition, ctx: PreconditionContext): Promise<PreconditionResult> {
  const key = req.arg;
  if (!key) {
    return {
      req,
      met: false,
      detail: `config: requires a key argument (e.g. config:embedding.model)`,
      hint: `specify a config key: config:<key> — see skillpack/preconditions.ts vocabulary`,
    };
  }
  const val = await ctx.getConfig(key);
  const met = typeof val === 'string' && val.trim().length > 0;
  return {
    req,
    met,
    detail: met ? `${key} is set` : `${key} is not set (empty or missing)`,
    hint: met ? `${key} is set` : `set it: gbrain config set ${key} <value>`,
  };
}

async function checkPages(req: Precondition, ctx: PreconditionContext): Promise<PreconditionResult> {
  const n = Number(req.arg);
  if (!req.arg || !Number.isFinite(n) || n < 0) {
    return {
      req,
      met: false,
      detail: `pages: requires a non-negative integer argument (e.g. pages:50)`,
      hint: `specify a page count: pages:<n> — see skillpack/preconditions.ts vocabulary`,
    };
  }
  const total = await ctx.countPages();
  const met = total >= n;
  return {
    req,
    met,
    detail: met ? `${total} page(s) present (>= ${n})` : `${total} page(s) present (< ${n})`,
    hint: met
      ? `brain has ${total} page(s) (>= ${n})`
      : `the brain needs >=${n} pages; ingest more first`,
  };
}
