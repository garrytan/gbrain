/**
 * `gbrain bootstrap verify` — the whole-install contract check
 * (agent-bootstrap plan: D8 + G1, G6, G13, CX2-5, CX-P0.5, ENG-tests, B2,
 * D3.6/A4 first-run tour).
 *
 * Every check is FAIL-SOFT and COLLECTED: a thrown probe becomes a failed
 * check with the error in `detail`, never an unhandled exception — the
 * runbook pastes the whole report to the human.
 *
 * Determinism [CX2-5]: verify never talks to a host's live serve. The caller
 * (the bootstrap dispatcher, or a test) holds the engine, so the graph-floor
 * seam is: write via the REAL put_page op handler (ctx.remote:false) →
 * `runMaintenanceSweep` directly (the `gbrain sweep --once` equivalent) →
 * edge query via the engine link tables. No timing nondeterminism, works
 * pre-registration AND as the weekly re-run (verify's caller holds the
 * engine either way).
 *
 * Keyless first-class [CX-P0.5]: the magic-moment fact is written through a
 * `## Facts` fence on the probe page and reconciled by the sweep's ZERO-LLM
 * fence pass, then read back at visibility='world' (the visibility the
 * harness can read, S3#1) — the check passes with zero API keys.
 *
 * [G13] Fixed probe slugs; prior leftovers are swept before writing; probe
 * deletion failure is a WARNING, not a verify failure.
 *
 * [B2] Every run persists to `<gbrain home>/bootstrap/verify-<ts>.json`,
 * keeping the last 5 snapshots. `bootstrap status` + doctor read them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { operations, type Operation, type OperationContext } from '../operations.ts';
import { loadConfigFileOnly, type GBrainConfig } from '../config.ts';
import { detectExecutionEnvironment } from '../execution-env.ts';
import { resolveGbrainHome } from '../gbrain-home.ts';
import { realpathOrResolve } from '../path-confine.ts';
import { runMaintenanceSweep } from '../sweep.ts';
import { detectCapabilities, renderCapabilityReport, type CapabilityReport } from '../capability.ts';
import { loadWorkspaceAllowlist, matchesGlob, scanFiles, type SecretFinding } from '../secret-scan.ts';
import { PUSH_DENY_GLOBS, verifyRemotePrivacy, readPushStatuses, summarizePushStatuses } from '../workspace-push.ts';
import { FACTS_DEFAULT_VISIBILITY_KEY } from '../facts/visibility.ts';
import { byteFloors } from './render.ts';
import { BOOTSTRAP_TEMPLATES, loadQuestionBank } from './assets.ts';
import { readManifest, writeManifest } from './format.ts';
import { status as interviewStatus } from './interview.ts';
import { gitOriginUrl, hooksInstalled } from './status.ts';
import { resolveSourceId } from '../source-resolver.ts';
import { auditWritebackContract } from './contract.ts';
import {
  ensureIpcSecret,
  resolveSocketPath,
  startResolveIpcServer,
} from '../context/resolve-ipc.ts';
import { assembleTurnContext } from '../context/turn-context.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyCheck {
  id: string;
  ok: boolean;
  /** Set when a non-ok state is advisory (does not fail the run). */
  warn?: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: VerifyCheck[];
  /** Human-readable report, capability block + first-run tour included. */
  report: string;
  capability: CapabilityReport;
  /** The three scripted first-run prompts [D3.6/A4]. */
  tour: string[];
  /** The OOBE hand-off lines (ownership + the cold-start next action) —
   *  unconditional in the shape like `tour`; printed in the report on PASS. */
  handoff: string[];
}

export interface VerifyOpts {
  /** Source the workspace brain/ dir registered as. Default 'workspace'. */
  sourceId?: string;
  /** Gbrain home for snapshot persistence. Default resolveGbrainHome(). */
  gbrainHomeDir?: string;
  /** Capability report override (test seam — mirrors SweepOpts). */
  capabilities?: CapabilityReport;
  /** Sweep wall-clock budget. Default 20s (fence + links passes are cheap). */
  sweepBudgetMs?: number;
  /** Skip the hooks IPC smoke (tests that don't stage a settings file). */
  skipHooksSmoke?: boolean;
  log?: (line: string) => void;
}

/** Fixed probe slugs [G13]. */
export const VERIFY_PROBE_SLUG = 'wiki/bootstrap-verify-probe';
export const VERIFY_PROBE_ENTITY_SLUG = 'wiki/bootstrap-verify-probe-entity';
/** Deterministic magic-moment token the fence fact carries [CX-P0.5]. */
export const VERIFY_MAGIC_TOKEN = 'verify-lighthouse-passphrase';

/** The three scripted first-run prompts [D3.6] — pinned by the A4 snapshot test.
 *  Exactly three (the count is copy-pinned here, in BOOTSTRAP_FOR_AGENTS.md,
 *  and the A4 plan). Prompt 3 must be TRUE on day one — the brain is empty at
 *  install, so "everything ingested so far" would be an anticlimax; the
 *  round-trip fact from prompt 2 is the honest day-one payoff. */
export const FIRST_RUN_TOUR: readonly string[] = [
  '"Who am I to you?" — identity from SOUL.md/USER.md, no lookup needed.',
  '"Remember that <one small true fact>." — it lands in the brain, not this chat.',
  '"What do you remember about me?" — asked in the NEW session: on day one that is the fact from prompt 2, recalled from the brain. Every session after this adds more. That round-trip is the whole product.',
];

// ---------------------------------------------------------------------------
// Op plumbing (trusted local ctx)
// ---------------------------------------------------------------------------

function findOp(name: string): Operation {
  const op = operations.find((o) => o.name === name);
  if (!op) throw new Error(`operation not found: ${name}`);
  return op;
}

function localCtx(engine: BrainEngine, sourceId: string, log?: (l: string) => void): OperationContext {
  const sink = log ?? (() => {});
  return {
    engine,
    config: (loadConfigFileOnly() ?? { engine: 'pglite' }) as GBrainConfig,
    logger: { info: sink, warn: sink, error: sink },
    dryRun: false,
    remote: false,
    sourceId,
  };
}

// ---------------------------------------------------------------------------
// Probe content
// ---------------------------------------------------------------------------

const PROBE_ENTITY_CONTENT = `---
title: Bootstrap Verify Probe Entity
type: concept
---

# Bootstrap Verify Probe Entity

Anchor page for the \`gbrain bootstrap verify\` graph-floor probe. Written and
deleted by verify; not user content.
`;

const PROBE_CONTENT = `---
title: Bootstrap Verify Probe
type: concept
---

# Bootstrap Verify Probe

Written and deleted by \`gbrain bootstrap verify\` (fixed slug, swept on every
run). It links to [[${VERIFY_PROBE_ENTITY_SLUG}]] so the graph floor has a
deterministic edge to extract.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | The bootstrap verify magic-moment token is ${VERIFY_MAGIC_TOKEN} | fact | 1.0 | world | low | | | bootstrap-verify | |
<!--- gbrain:facts:end -->
`;

/** Remove any prior probe state [G13]: page rows (hard — verify is a trusted
 * local caller and the probe is not user content), reconciled probe facts,
 * and write-through files under brain/. Best-effort, never throws. */
async function sweepProbeLeftovers(engine: BrainEngine, ws: string, sourceId: string): Promise<void> {
  for (const slug of [VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG]) {
    try {
      await engine.deletePage(slug, { sourceId });
    } catch {
      /* absent / engine without hard delete — soft path below still applies */
    }
    try {
      rmSync(join(ws, 'brain', `${slug}.md`), { force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    // Scope the delete to the EXACT probe page(s) this run wrote (via the
    // v51 fence column source_markdown_slug), NEVER a `fact LIKE %token%`
    // substring match — a user fact that merely mentions the token string
    // must survive verify's cleanup [G13].
    await engine.executeRaw(
      `DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug IN ($2, $3)`,
      [sourceId, VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG],
    );
  } catch {
    /* facts table may not exist on a pre-migration brain — doctor_green names that */
  }
}

// ---------------------------------------------------------------------------
// Individual checks (each returns a VerifyCheck; never throws)
// ---------------------------------------------------------------------------

async function checkDoctorGreen(engine: BrainEngine): Promise<VerifyCheck> {
  const id = 'doctor_green';
  try {
    // The cheapest existing health probe: config round-trip + schema probe.
    // Deliberately NOT a shell-out to `gbrain doctor` (a second engine open
    // would contend for the PGLite lock verify's caller already holds).
    const version = await engine.getConfig('version');
    await engine.executeRaw(`SELECT 1 FROM pages LIMIT 1`, []);
    return { id, ok: true, detail: `engine healthy (schema version ${version ?? 'unrecorded'})` };
  } catch (e) {
    return { id, ok: false, detail: `engine probe failed: ${(e as Error).message}` };
  }
}

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

function checkTokenSweep(ws: string): VerifyCheck {
  const id = 'token_sweep';
  try {
    const manifest = readManifest(ws);
    if (manifest.state === 'template') {
      // Minimal-mode template trees legitimately keep the six required-key
      // markers — the sweep would be a false alarm on a template clone.
      return { id, ok: true, warn: true, detail: 'template clone (initialized:false) — placeholder tokens are expected; render before verifying for real' };
    }
    const offenders: string[] = [];
    for (const t of BOOTSTRAP_TEMPLATES) {
      const p = join(ws, t.dest);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p, 'utf8');
      const tokens = [...raw.matchAll(TOKEN_RE)].map((m) => m[1]);
      if (tokens.length > 0) offenders.push(`${t.dest} (${[...new Set(tokens)].join(', ')})`);
    }
    if (offenders.length > 0) {
      return { id, ok: false, detail: `unresolved {{TOKEN}}s in rendered files: ${offenders.join('; ')} — finish the interview and re-run render` };
    }
    return { id, ok: true, detail: 'no unresolved template tokens in rendered identity files' };
  } catch (e) {
    return { id, ok: false, detail: `token sweep failed: ${(e as Error).message}` };
  }
}

function checkByteFloors(ws: string): VerifyCheck {
  const id = 'byte_floors';
  try {
    const bank = loadQuestionBank();
    const st = interviewStatus(ws);
    const answeredCount = st.ok ? st.answered.filter((k) => bank.interviewKeys.includes(k)).length : 0;
    const floors = byteFloors(answeredCount);
    const problems: string[] = [];
    for (const [file, floor] of Object.entries(floors)) {
      const p = join(ws, file);
      if (!existsSync(p)) {
        problems.push(`${file} missing`);
        continue;
      }
      const size = statSync(p).size;
      if (size < floor) problems.push(`${file} is ${size}B < floor ${floor}B (@${answeredCount} answered)`);
    }
    if (problems.length > 0) {
      return { id, ok: false, detail: `byte floors: ${problems.join('; ')} — floors catch skipped interviews, never pad; re-run the interview + render` };
    }
    return { id, ok: true, detail: `SOUL.md/USER.md above floors for ${answeredCount} answered question(s)` };
  } catch (e) {
    return { id, ok: false, detail: `byte-floor check failed: ${(e as Error).message}` };
  }
}

/** A healthy retrieval surface without a same-turn write-back contract is a
 * one-way memory: useful now, stale later. Fresh bootstrap renders this gate;
 * the check catches pre-bootstrap/custom workspaces and points at the
 * additive repair command rather than overwriting their AGENTS.md. */
export function checkWritebackContract(ws: string): VerifyCheck {
  const audit = auditWritebackContract(ws);
  return audit.ok
    ? { id: 'writeback_contract', ok: true, detail: audit.detail }
    : {
        id: 'writeback_contract',
        ok: false,
        detail: `${audit.detail}. Fix: run \`gbrain bootstrap contract --repair\` from the workspace (or pass --workspace explicitly).`,
      };
}

/** Tracked files via git; falls back to the rendered file set + state/ when
 * the workspace is not (yet) a git repo. */
function trackedWorkspaceFiles(ws: string): { files: string[]; via: 'git' | 'fallback' } {
  try {
    const out = execFileSync('git', ['-C', ws, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    }).toString();
    const rel = out.split('\0').filter((s) => s.length > 0);
    if (rel.length > 0) return { files: rel, via: 'git' };
  } catch {
    /* not a repo — fallback below */
  }
  const files: string[] = [];
  for (const t of BOOTSTRAP_TEMPLATES) {
    if (existsSync(join(ws, t.dest))) files.push(t.dest);
  }
  if (existsSync(join(ws, 'state', 'interview.json'))) files.push(join('state', 'interview.json'));
  return { files, via: 'fallback' };
}

function checkSecretScan(ws: string): VerifyCheck {
  const id = 'secret_scan';
  try {
    const { files, via } = trackedWorkspaceFiles(ws);
    const allowlist = loadWorkspaceAllowlist(ws);
    const findings: SecretFinding[] = scanFiles(files.map((f) => join(ws, f)), {
      allowlist,
      workspaceRoot: ws,
    });
    if (findings.length > 0) {
      const sample = findings.slice(0, 5).map((f) => `${f.file}:${f.line} [${f.pattern}] ${f.fingerprint}`).join('; ');
      return { id, ok: false, detail: `${findings.length} secret-scan finding(s): ${sample}${findings.length > 5 ? '; …' : ''} — fix, or allowlist a false positive in .gbrain-scan-allow` };
    }
    return { id, ok: true, detail: `no secrets in ${files.length} ${via === 'git' ? 'tracked' : 'workspace'} file(s)` };
  } catch (e) {
    return { id, ok: false, detail: `secret scan failed: ${(e as Error).message}` };
  }
}

function checkDenyGlobs(ws: string): VerifyCheck {
  const id = 'deny_globs';
  try {
    const { files, via } = trackedWorkspaceFiles(ws);
    const matches = files.filter((f) => PUSH_DENY_GLOBS.some((g) => matchesGlob(g, f)));
    if (via === 'git' && matches.length > 0) {
      return { id, ok: false, detail: `deny-glob matches among candidate files: ${matches.slice(0, 10).join(', ')} — remove from the index (git rm --cached) before any push` };
    }
    return { id, ok: true, detail: via === 'git' ? 'no tracked files match the push deny list' : 'not a git repo yet — deny-glob backstop applies at push time' };
  } catch (e) {
    return { id, ok: false, detail: `deny-glob check failed: ${(e as Error).message}` };
  }
}

/** Self-repair channel for existing installs [B8]: a git-TRACKED .mcp.json
 * carries an absolute machine-specific binary path into the private repo.
 * Fresh renders gitignore it; this warn heals pre-fix installs. Never gates. */
function checkMcpJsonHygiene(ws: string): VerifyCheck {
  const id = 'mcp_json_hygiene';
  try {
    if (!existsSync(join(ws, '.mcp.json'))) return { id, ok: true, detail: 'no .mcp.json in the workspace' };
    try {
      execFileSync('git', ['-C', ws, 'ls-files', '--error-unmatch', '.mcp.json'], {
        stdio: 'ignore', timeout: 5_000,
      });
    } catch {
      return { id, ok: true, detail: '.mcp.json present but untracked (gitignored) — correct' };
    }
    return {
      id,
      ok: true, // warn-only: informational, never gating
      detail:
        'WARN: machine-specific .mcp.json is COMMITTED to the repo — run `git rm --cached .mcp.json` ' +
        '(bootstrap now gitignores it; it regenerates via `claude mcp add` / `bootstrap hooks --repair`)',
    };
  } catch (e) {
    return { id, ok: true, detail: `mcp.json hygiene probe failed (${(e as Error).message})` };
  }
}

/** [D12 upgrade-path guard]: an event carried by BOTH hook files double-fires
 * every turn (possible when the committed carrier arrives via git pull onto a
 * machine whose local file predates the dedupe-aware writers). Warn-only. */
function checkHookCarrierOverlap(ws: string): VerifyCheck {
  const id = 'hook_carrier_overlap';
  try {
    const events = (['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const).filter((event) => {
      const has = (rel: string): boolean => {
        try {
          const parsed = JSON.parse(readFileSync(join(ws, rel), 'utf8')) as { hooks?: Record<string, unknown> };
          const groups = parsed?.hooks?.[event];
          return Array.isArray(groups) && JSON.stringify(groups).includes('"_gbrain"');
        } catch {
          return false;
        }
      };
      return has(join('.claude', 'settings.json')) && has(join('.claude', 'settings.local.json'));
    });
    if (events.length === 0) return { id, ok: true, detail: 'no event fires from both hook carriers' };
    return {
      id,
      ok: true, // warn-only self-repair channel
      detail: `WARN: ${events.join(', ')} fire from BOTH .claude/settings.json and settings.local.json (double-fire) — run \`gbrain bootstrap hooks --repair\` to dedupe`,
    };
  } catch (e) {
    return { id, ok: true, detail: `carrier overlap probe failed (${(e as Error).message})` };
  }
}

async function checkRepoPrivacy(ws: string): Promise<VerifyCheck> {
  const id = 'repo_privacy';
  try {
    const origin = gitOriginUrl(ws);
    if (!origin) {
      return { id, ok: true, detail: 'local-only (no origin remote) — run `gbrain bootstrap repo` any time to add the private body' };
    }
    const verdict = await verifyRemotePrivacy(ws);
    if (verdict.verdict === 'private') return { id, ok: true, detail: `origin verified private (${origin})` };
    if (verdict.verdict === 'not_private') return { id, ok: false, detail: `origin is NOT private: ${verdict.detail} — make it private before pushing workspace contents` };
    return { id, ok: false, detail: `origin visibility unverifiable (${verdict.detail}) — refusing to bless an unverified remote [G8]; re-run once gh works` };
  } catch (e) {
    return { id, ok: false, detail: `repo privacy check failed: ${(e as Error).message}` };
  }
}

/** Informational, NEVER gating [D-cloud]: name the detected execution
 * environment and its expected degradations so an installing agent (and the
 * pasted verify report) states them as facts instead of rediscovering them
 * as mystery failures. */
function checkExecutionEnvironment(): VerifyCheck {
  const id = 'execution_env';
  try {
    const env = detectExecutionEnvironment();
    if (env === 'cloud-sandbox') {
      return {
        id,
        ok: true,
        detail:
          'cloud sandbox detected — expected degradations: no crontab (scheduled pull skipped; per-turn/session-end pushes cover it); ' +
          'GitHub GraphQL always blocked and REST scoped to session-attached repos (privacy verification falls back to git protocol); ' +
          'pushes restricted to the session\'s working branch; only repo-committed files carry into the next session',
      };
    }
    if (env === 'ephemeral-container') {
      return {
        id,
        ok: true,
        detail: 'container detected — no reliable scheduler (scheduled pull skipped); event-driven pushes cover persistence',
      };
    }
    return { id, ok: true, detail: 'local machine — full persistence surface available' };
  } catch (e) {
    return { id, ok: true, detail: `environment detection failed (${(e as Error).message}) — treated as local` };
  }
}

/** [CX-P1.1] Single-principal posture: facts written without an explicit
 * visibility must be recallable by the owner's own sessions (the harness
 * reads at visibility='world'). Set-IF-UNSET only, through the engine config
 * plane — an operator's explicit value (e.g. 'private' for a brain exposed to
 * other surfaces) is NEVER overridden. The report line names the posture and
 * where to flip it. */
async function ensureDefaultVisibilityPosture(engine: BrainEngine): Promise<VerifyCheck> {
  const id = 'facts_visibility';
  try {
    const existing = await engine.getConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    if (existing == null || existing.trim() === '') {
      await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
      return {
        id,
        ok: true,
        detail:
          `facts default visibility: world (set by bootstrap verify — was unset). ` +
          `Flip with \`gbrain config set ${FACTS_DEFAULT_VISIBILITY_KEY} private\` if less-trusted surfaces will read this brain.`,
      };
    }
    return {
      id,
      ok: true,
      detail:
        `facts default visibility: ${existing.trim()} (explicit operator value — untouched). ` +
        `Flip with \`gbrain config set ${FACTS_DEFAULT_VISIBILITY_KEY} <world|private>\`.`,
    };
  } catch (e) {
    return { id, ok: true, warn: true, detail: `could not read/set ${FACTS_DEFAULT_VISIBILITY_KEY}: ${(e as Error).message}` };
  }
}

/**
 * #4287 — ACTIVE embedding-plane probe. A verify that passes its roundtrip
 * keyless-style while the configured embedder and the schema column disagree
 * certifies a brain on which every keyed write fails ("expected N dimensions,
 * not M"). Config numbers can lie about what the runtime emits (the observed
 * split emitted the compiled-in default, a width no config plane named), so
 * in keyed mode this embeds ONE short probe string through the same
 * document-side path put_page uses and compares the RETURNED width to the
 * actual `content_chunks.embedding` column width. Keyless installs pass (no
 * active plane exists — writes store no vectors by design); a transient probe
 * failure WARNs (the roundtrip owns hard put failures); a confirmed width
 * mismatch is a named FAIL with the recovery command.
 */
export async function checkEmbeddingPlane(
  engine: BrainEngine,
  caps: CapabilityReport,
): Promise<VerifyCheck> {
  const id = 'embedding_plane';
  // S2: resolve the registry-ACTIVE write column FIRST — comparing the
  // embedder to the literal legacy `embedding` column false-FAILs a healthy
  // brain whose registry routes writes elsewhere (e.g. a 1024d Voyage
  // column). An unresolvable registry row is itself a genuine FAIL: every
  // chunk write throws the resolver error until the config row is fixed.
  let activeColName: string;
  try {
    const { resolveActiveEmbeddingColumnFromEngine } = await import('../search/embedding-column.ts');
    activeColName = (await resolveActiveEmbeddingColumnFromEngine(engine)).name;
  } catch (e) {
    return {
      id,
      ok: false,
      detail:
        `the configured embedding column cannot be resolved (${(e as Error).message}) — every chunk ` +
        `write fails until the registry row is fixed. Inspect \`gbrain config get search_embedding_column\` ` +
        `and \`gbrain config get embedding_columns\`.`,
    };
  }
  const colLabel = `content_chunks.${activeColName}`;
  let colDims: number | null = null;
  let colExists = false;
  try {
    const { readContentChunksColumnDim } = await import('../embedding-dim-check.ts');
    const col = await readContentChunksColumnDim(engine, activeColName);
    colDims = col.dims;
    colExists = col.exists;
  } catch (e) {
    return { id, ok: true, warn: true, detail: `embedding column width probe failed (${colLabel}): ${(e as Error).message}` };
  }
  if (!caps.embeddings.available) {
    return {
      id,
      ok: true,
      detail: `keyless — no embedding provider configured; writes store no vectors (active column ${colLabel}: ${colExists ? `${colDims ?? '?'}d` : 'absent'})`,
    };
  }
  if (!colExists) {
    return {
      id,
      ok: false,
      detail: `embeddings are configured but the active ${colLabel} column is ABSENT — every embedding write fails. Run \`gbrain migrate embeddings --status\` to diagnose, then \`gbrain migrate embeddings --to <provider:model>\` to (re)build it.`,
    };
  }
  try {
    // Same document-side embed path put_page uses (import-file.ts embedBatch),
    // lazy so keyless verifies never load the gateway.
    const { embedBatch, getEmbeddingModelName } = await import('../embedding.ts');
    const vecs = await embedBatch(['gbrain bootstrap verify embedding-plane probe']);
    const got = vecs[0]?.length ?? 0;
    let model = 'unknown';
    try { model = getEmbeddingModelName(); } catch { /* label only */ }
    if (colDims !== null && got !== colDims) {
      return {
        id,
        ok: false,
        detail:
          `EMBEDDING PLANE SPLIT: the runtime embedder (${model}) returns ${got}d vectors but ` +
          `${colLabel} is ${colDims}d — every embedding write fails ("expected ${colDims} ` +
          `dimensions, not ${got}") and nothing is stored. Fix: gbrain migrate embeddings --to <provider:model> ` +
          `--dim ${got} (or correct embedding_model/embedding_dimensions to match the column).`,
      };
    }
    return {
      id,
      ok: true,
      detail: `active plane verified end-to-end: ${model} emits ${got}d = ${colLabel} ${colDims ?? got}d`,
    };
  } catch (e) {
    // A dead/misconfigured provider surfaces in the roundtrip put; this check
    // only certifies plane AGREEMENT, so degrade to a warning here.
    return { id, ok: true, warn: true, detail: `live embed probe failed (${(e as Error).message}) — cannot verify the active embedding plane end-to-end` };
  }
}

/** Effective MCP-surface posture: bootstrap registrations pin `--surface
 * full`, but a REGISTRATION THAT PREDATES that pin resolves the config key —
 * `mcp_surface: 'verbs'` would silently narrow the bootstrap contract
 * (put_page/get_page/timeline are not memory verbs). Loud WARN naming the fix. */
function checkMcpSurface(): VerifyCheck {
  const id = 'mcp_surface';
  try {
    const surface = loadConfigFileOnly()?.mcp_surface;
    if (surface === 'verbs') {
      return {
        id,
        ok: true,
        warn: true,
        detail:
          `config mcp_surface='verbs' narrows a bare \`gbrain serve\` to the five memory verbs — the bootstrap ` +
          `contract needs the full surface. Fix: re-run \`gbrain bootstrap hooks --repair\` (registrations now pin ` +
          `--surface full) or \`gbrain config set mcp_surface full\`.`,
      };
    }
    return { id, ok: true, detail: `mcp_surface: ${surface ?? 'full (default)'} — full op surface for registrations` };
  } catch (e) {
    return { id, ok: true, warn: true, detail: `mcp_surface config unreadable: ${(e as Error).message}` };
  }
}

/**
 * Pure, engine-free derivation of the collision-fallback source_id for a
 * workspace — a deterministic hash of the workspace's real path, no DB
 * lookup involved. `resolveSourceIdCollision` (below) is the only thing that
 * decides WHETHER this id is actually needed (that half requires the engine,
 * since the sources registry lives only in the DB) — but the id itself is
 * safe to preview from an engine-free phase. `bootstrap hooks` does exactly
 * that, so a human has the fallback id in hand before they ever hand-register
 * a source, instead of discovering it only after an FK error + a corrective
 * `verify` run.
 */
export function deriveWorkspaceSourceId(ws: string): string {
  const hash = createHash('sha256').update(realpathOrResolve(ws)).digest('hex').slice(0, 8);
  return `workspace-${hash}`;
}

/**
 * Resolve the source id a verify run should exercise (#4328). An initialized
 * manifest is authoritative (that's the id hooks/attach/status all follow).
 * An UNINITIALIZED workspace has no manifest to consult — the old hardcoded
 * 'workspace' fallback pointed the probe writes at a source no one ever
 * registered, so put_page died on its sources FK. Instead, run the standard
 * source-resolution chain rooted at the workspace (registered local_path →
 * brain default → seeded 'default'), which always lands on a real source.
 * Any resolver surprise degrades to 'default' (seeded by migration) rather
 * than failing verify before it can print a report.
 */
export async function resolveVerifySourceId(engine: BrainEngine, ws: string): Promise<string> {
  const state = readManifest(ws);
  if (state.state === 'initialized') return state.manifest.source_id;
  try {
    return await resolveSourceId(engine, null, ws);
  } catch {
    return 'default';
  }
}

/**
 * source_id collision resolution [engine seam]. Render is ENGINE-FREE and the
 * sources registry lives ONLY in the DB (no registry file exists), so verify —
 * the one bootstrap subcommand holding an engine — is where a manifest
 * source_id already registered to a DIFFERENT checkout is detected. On
 * collision it derives a stable `workspace-<8char-path-hash>` id (via
 * `deriveWorkspaceSourceId`), persists it to agent.json (render preserves it
 * on re-render), and names the re-register steps; every consumer (hooks
 * GBRAIN_SOURCE env, verify, status hints, attach, repo persistence) reads
 * manifest.source_id, so the derived id propagates. Returns a sourceId ONLY
 * when it derived one.
 */
async function resolveSourceIdCollision(
  engine: BrainEngine,
  ws: string,
): Promise<{ sourceId: string | null; check: VerifyCheck | null }> {
  const state = readManifest(ws);
  if (state.state !== 'initialized') return { sourceId: null, check: null };
  const current = state.manifest.source_id;
  const brainDir = join(ws, 'brain');
  try {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [current],
    );
    const registered = rows[0]?.local_path ?? null;
    if (rows.length === 0 || registered === null) return { sourceId: null, check: null };
    if (realpathOrResolve(registered) === realpathOrResolve(brainDir)) {
      return { sourceId: null, check: null }; // same checkout — no collision
    }
    const derived = deriveWorkspaceSourceId(ws);
    writeManifest(ws, { ...state.manifest, source_id: derived });
    return {
      sourceId: derived,
      check: {
        id: 'source_id',
        ok: true,
        warn: true,
        detail:
          `source '${current}' is already registered to a different checkout (${registered}) — derived ` +
          `'${derived}' and persisted it to agent.json. Register it (gbrain sources add ${derived} --path ${brainDir}) ` +
          `and re-run \`gbrain bootstrap hooks --repair\` so GBRAIN_SOURCE follows.`,
      },
    };
  } catch (e) {
    return {
      sourceId: null,
      check: { id: 'source_id', ok: true, warn: true, detail: `source-id collision probe failed: ${(e as Error).message}` },
    };
  }
}

interface RoundtripOutcome {
  checks: VerifyCheck[];
}

/** The G1/CX2-5 core: put_page (real op, remote:false) → committed file under
 * brain/ → sweep → graph floor via link tables → get_page → search → magic
 * moment (keyless fence fact) → delete probes. */
async function runRoundtrip(
  engine: BrainEngine,
  ws: string,
  sourceId: string,
  opts: VerifyOpts,
): Promise<RoundtripOutcome> {
  const checks: VerifyCheck[] = [];
  const ctx = localCtx(engine, sourceId, opts.log);
  const putPage = findOp('put_page');
  const getPage = findOp('get_page');
  const queryOp = findOp('query');

  await sweepProbeLeftovers(engine, ws, sourceId);

  // 1. Write both probe pages through the REAL op handler [G1].
  let writeThroughDetail = '';
  try {
    await putPage.handler(ctx, { slug: VERIFY_PROBE_ENTITY_SLUG, content: PROBE_ENTITY_CONTENT });
    const res = (await putPage.handler(ctx, { slug: VERIFY_PROBE_SLUG, content: PROBE_CONTENT })) as {
      write_through?: { written: boolean; path?: string; skipped?: string; error?: string };
    };
    const wt = res.write_through;
    const expectedFile = join(ws, 'brain', `${VERIFY_PROBE_SLUG}.md`);
    if (wt?.written && wt.path && existsSync(wt.path)) {
      writeThroughDetail = `file materialized at ${wt.path}`;
      checks.push({ id: 'roundtrip', ok: true, detail: `put_page landed in DB and ${writeThroughDetail}` });
    } else if (existsSync(expectedFile)) {
      checks.push({ id: 'roundtrip', ok: true, detail: `put_page landed in DB and file materialized at ${expectedFile}` });
    } else if (wt?.skipped === 'disabled_by_config') {
      // DB-only by operator choice (`sync.write_through=false`), not a broken
      // install: the DB write landed, so WARN and keep the remaining
      // roundtrip-family checks — sweep/graph/search/magic-moment all run off
      // the DB row and still prove the memory loop.
      checks.push({
        id: 'roundtrip',
        ok: true,
        warn: true,
        detail:
          `put_page landed in DB; no file under brain/ because sync.write_through is disabled by config — ` +
          `agent writes stay DB-only (run \`gbrain config set sync.write_through true\` to materialize repo files)`,
      });
    } else {
      // [G1] A green verify with an empty repo is impossible: name the
      // write-through problem explicitly.
      const why = wt?.skipped ?? wt?.error ?? 'write-through reported nothing';
      checks.push({
        id: 'roundtrip',
        ok: false,
        detail:
          `put_page wrote the DB but NO file appeared under brain/ (write-through: ${why}). ` +
          `The workspace source must be registered with its brain/ dir as local_path ` +
          `(gbrain sources add ${sourceId} --path ${join(ws, 'brain')}) or agent writes never reach the repo.`,
      });
      return { checks };
    }
  } catch (e) {
    checks.push({ id: 'roundtrip', ok: false, detail: `put_page failed: ${(e as Error).message}` });
    return { checks };
  }

  // 2. Sweep — the `gbrain sweep --once` equivalent, run in-process because
  // verify's caller holds the engine [CX2-5].
  const caps = opts.capabilities ?? detectCapabilities();
  try {
    const report = await runMaintenanceSweep(engine, {
      sourceId,
      budgetMs: opts.sweepBudgetMs ?? 20_000,
      capabilities: caps,
      log: opts.log,
    });
    opts.log?.(`[verify] sweep: facts=${report.factsReconciled} links=${report.linksExtracted} timeline=${report.timelineExtracted}`);
  } catch (e) {
    checks.push({ id: 'graph_floor', ok: false, detail: `maintenance sweep failed: ${(e as Error).message}` });
    return { checks };
  }

  // 3. Graph floor: ≥1 extracted edge, answered through the link tables.
  try {
    const links = await engine.getLinks(VERIFY_PROBE_SLUG, { sourceId });
    const edge = links.find((l) => l.to_slug === VERIFY_PROBE_ENTITY_SLUG);
    const backlinks = await engine.getBacklinks(VERIFY_PROBE_ENTITY_SLUG, { sourceId });
    const back = backlinks.find((l) => l.from_slug === VERIFY_PROBE_SLUG);
    if (edge && back) {
      checks.push({ id: 'graph_floor', ok: true, detail: `entity link extracted and the edge-only query answers (probe → entity, ${links.length} outbound / ${backlinks.length} inbound)` });
    } else {
      checks.push({ id: 'graph_floor', ok: false, detail: `expected probe→entity edge missing after sweep (outbound: ${links.length}, inbound: ${backlinks.length}) — link extraction is not compounding the graph` });
    }
  } catch (e) {
    checks.push({ id: 'graph_floor', ok: false, detail: `edge query failed: ${(e as Error).message}` });
  }

  // 4. get_page + search recall.
  try {
    await getPage.handler(ctx, { slug: VERIFY_PROBE_SLUG });
  } catch (e) {
    checks.push({ id: 'roundtrip', ok: false, detail: `get_page read-back failed: ${(e as Error).message}` });
  }
  try {
    const result = await queryOp.handler(ctx, {
      query: 'bootstrap verify probe lighthouse',
      limit: 10,
      expand: false,
    });
    const found = JSON.stringify(result).includes(VERIFY_PROBE_SLUG);
    if (!found) {
      checks.push({ id: 'roundtrip', ok: false, detail: `search did not return the probe page (${caps.search} search) — retrieval round-trip broken` });
    }
  } catch (e) {
    checks.push({ id: 'roundtrip', ok: false, detail: `search failed: ${(e as Error).message}` });
  }

  // 5. Magic moment [CX-P0.5]: the fence fact reconciled by the ZERO-LLM
  // sweep pass, read back at visibility='world' (what the harness can read).
  try {
    const rows = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts WHERE source_id = $1 AND visibility = 'world' AND fact LIKE $2 LIMIT 1`,
      [sourceId, `%${VERIFY_MAGIC_TOKEN}%`],
    );
    if (rows.length > 0) {
      checks.push({ id: 'magic_moment', ok: true, detail: `fence-written fact recalled at visibility=world (keyless path: ${caps.mode === 'keyless' ? 'yes' : 'keyed install, same zero-LLM pass'})` });
    } else {
      checks.push({ id: 'magic_moment', ok: false, detail: 'the ## Facts fence fact never reached the facts index — keyless memory (agent-authored fences) is broken; check the sweep fence pass' });
    }
  } catch (e) {
    checks.push({ id: 'magic_moment', ok: false, detail: `facts read-back failed: ${(e as Error).message}` });
  }

  // 6. Delete the probes [G13] — failure is a WARNING, never a verify fail.
  // HARD delete via the engine primitive (same as sweepProbeLeftovers): the
  // probe is not user content and verify is a trusted local caller. The
  // delete_page OP is a v0.26.5 SOFT delete (sets deleted_at, row stays in
  // pages until the 72h purge) — using it here left two probe tombstones in
  // the user's brain after every verify run, visible to include_deleted
  // readers and pinned as residue by the Postgres e2e cleanup assertion.
  const deleteWarnings: string[] = [];
  for (const slug of [VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG]) {
    try {
      await engine.deletePage(slug, { sourceId });
    } catch (e) {
      deleteWarnings.push(`${slug}: ${(e as Error).message}`);
    }
    try {
      rmSync(join(ws, 'brain', `${slug}.md`), { force: true });
    } catch {
      /* best effort */
    }
  }
  try {
    // Exact-identity delete (see sweepProbeLeftovers): only facts whose fence
    // lives on a probe page, never a token substring match over user facts.
    await engine.executeRaw(
      `DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug IN ($2, $3)`,
      [sourceId, VERIFY_PROBE_SLUG, VERIFY_PROBE_ENTITY_SLUG],
    );
  } catch {
    /* best effort */
  }
  if (deleteWarnings.length > 0) {
    checks.push({ id: 'probe_cleanup', ok: false, warn: true, detail: `probe deletion incomplete: ${deleteWarnings.join('; ')}` });
  }

  return { checks };
}

/** Hooks smoke [D8#8 as amended by CX2-5]: hooks installed → pipe a fixture
 * UserPromptSubmit stdin into runHook('user-prompt') IN-PROCESS against a
 * live in-process IPC server backed by the verify engine (the
 * test/resolve-ipc-v2 pattern). Asserts exit 0 + within the hook's own
 * USER_PROMPT_DEADLINE_MS budget + non-empty block or a documented
 * degradation. */
async function checkHooksSmoke(engine: BrainEngine, ws: string, sourceId: string): Promise<VerifyCheck> {
  const id = 'hooks_smoke';
  if (!hooksInstalled(ws)) {
    return { id, ok: true, detail: 'hooks not installed — smoke not applicable (Codex/pull-mode or declined consent)' };
  }
  if (process.env.GBRAIN_HOOKS === '0') {
    return { id, ok: true, warn: true, detail: 'GBRAIN_HOOKS=0 kill switch is set — hooks are installed but disabled; unset it to re-enable per-turn context' };
  }
  let cfg: GBrainConfig | null = null;
  try {
    cfg = loadConfigFileOnly();
  } catch {
    cfg = null;
  }
  const dataDir = cfg?.database_path;
  if (!dataDir) {
    return { id, ok: true, warn: true, detail: 'no PGLite data dir in config (Postgres brain?) — IPC smoke not applicable' };
  }
  let server: { close: () => void } | null = null;
  const prevSource = process.env.GBRAIN_SOURCE;
  const socketPath = resolveSocketPath(dataDir);
  // #4474: prefer the REAL socket. Pre-fix the smoke ALWAYS started its own
  // in-process IPC server, so it manufactured the exact condition it was
  // testing — a serve posture that never binds IPC (the old `serve --http`)
  // still passed verify while every production hook degraded to no_serve.
  // A present socket now means "a live serve is the provider; exercise IT";
  // only when NO socket exists do we self-provide (plumbing-only smoke) and
  // say so honestly in the result.
  const liveSocket = existsSync(socketPath);
  try {
    if (!liveSocket) {
      const secret = ensureIpcSecret(dataDir);
      server = await startResolveIpcServer(
        socketPath,
        {
          resolve: async () => null,
          turn_context: (req) =>
            assembleTurnContext(engine, {
              sourceId,
              window: req.window,
              ...(req.priorContextText !== undefined ? { priorContextText: req.priorContextText } : {}),
              ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
              ...(req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : {}),
            }),
        },
        { secret, boundSourceId: sourceId },
      );
      if (!server) {
        return { id, ok: true, warn: true, detail: 'could not bind the IPC socket (a live serve owns it?) — smoke skipped; the live serve itself is the IPC provider' };
      }
    }
    // Provenance suffix for every outcome below: which listener answered.
    const via = liveSocket
      ? 'via the live serve’s IPC socket'
      : `via a verify-owned IPC server (no live serve socket at ${socketPath} — hooks stay degraded (no_serve) until a running \`gbrain serve\` binds it)`;
    process.env.GBRAIN_SOURCE = sourceId;
    // USER_PROMPT_DEADLINE_MS is the hook's own budget — the smoke compares
    // against the same constant it enforces (no drifting hardcoded copy).
    const { runHook, readHeartbeatTail, USER_PROMPT_DEADLINE_MS } = await import('../../commands/hook.ts');
    let out = '';
    const t0 = Date.now();
    const code = await runHook(['user-prompt'], {
      stdin: JSON.stringify({ prompt: 'bootstrap verify smoke: who am I to you?', session_id: 'bootstrap-verify' }),
      write: (s: string) => {
        out += s;
      },
      cwd: ws,
    });
    const elapsed = Date.now() - t0;
    if (code !== 0) return { id, ok: false, detail: `hook exited ${code} (must fail open with exit 0)` };
    if (out.trim().length > 0) {
      if (elapsed >= USER_PROMPT_DEADLINE_MS) {
        // [A7] Real latency is a non-gating benchmark — the hard deadline
        // assertion lives in the hook tests against an injected slow-IPC stub.
        return { id, ok: true, warn: true, detail: `context block delivered but in ${elapsed}ms (over the ${USER_PROMPT_DEADLINE_MS}ms budget on this box) ${via} — watch hook latency` };
      }
      // #4474: a self-provided listener is a plumbing-only pass — production
      // hooks still need a live serve to bind the socket, so it WARNS.
      return liveSocket
        ? { id, ok: true, detail: `context block delivered in ${elapsed}ms (${out.trim().length} chars) ${via}` }
        : { id, ok: true, warn: true, detail: `context block delivered in ${elapsed}ms (${out.trim().length} chars) ${via}` };
    }
    // Empty stdout must be a DOCUMENTED degradation — read the heartbeat it wrote.
    const tail = await readHeartbeatTail(1);
    const reason = tail[tail.length - 1]?.reason ?? 'empty_block';
    if (reason === 'empty_block' || reason === 'empty_window') {
      return { id, ok: true, warn: true, detail: `empty context block in ${elapsed}ms (documented degradation: ${reason}) ${via} — plumbing works, brain has nothing to volunteer yet` };
    }
    if (reason === 'deadline' || reason === 'ipc_unavailable' || reason === 'server_budget') {
      // [A7] Latency-shaped degradations don't gate verify (slow CI box ≠
      // broken install); the reason is named so a human can judge.
      return { id, ok: true, warn: true, detail: `hook degraded on latency (${reason}) in ${elapsed}ms ${via} — non-gating; re-run on an idle machine if it persists` };
    }
    return { id, ok: false, detail: `hook degraded (${reason}) in ${elapsed}ms ${via} — stdin→IPC→stdout plumbing is not healthy` };
  } catch (e) {
    return { id, ok: false, detail: `hooks smoke failed: ${(e as Error).message}` };
  } finally {
    if (prevSource === undefined) delete process.env.GBRAIN_SOURCE;
    else process.env.GBRAIN_SOURCE = prevSource;
    try {
      server?.close();
    } catch {
      /* noop */
    }
  }
}

function checkPushProbe(ws: string): VerifyCheck {
  const id = 'push_probe';
  try {
    // Read through the shared per-root reader [D8/D13] — a v0.45.8+ push
    // writes push-status-<roothash>.json, not the legacy single file, so the
    // old direct read reported "no push recorded" on every fresh install.
    const entries = readPushStatuses();
    if (entries.length > 0) {
      const { failing } = summarizePushStatuses(entries);
      if (failing.length > 0) {
        const s = failing[0]!;
        const rest = failing.length > 1 ? ` [+${failing.length - 1} more]` : '';
        return { id, ok: true, warn: true, detail: `last workspace push FAILED (${s.ts ?? 'unknown'}): ${s.reason ?? 'unknown'}${rest} — run \`gbrain sources push --path ${s.repoRoot ?? ws}\`` };
      }
      const ok = entries.find((e) => e.ok === true);
      return { id, ok: true, detail: `last workspace push succeeded (${ok?.ts ?? 'unknown time'})` };
    }
    const origin = gitOriginUrl(ws);
    if (origin) return { id, ok: true, warn: true, detail: 'origin exists but no push recorded yet — run `gbrain sources push` once to prove the persistence path' };
    return { id, ok: true, detail: 'local-only mode — no push expected' };
  } catch (e) {
    return { id, ok: true, warn: true, detail: `push probe unreadable: ${(e as Error).message}` };
  }
}

function checkInertSkills(ws: string, caps: CapabilityReport): VerifyCheck {
  const id = 'inert_skills';
  const dir = join(ws, 'skills');
  if (!existsSync(dir)) return { id, ok: true, detail: 'no skills/ dir — scaffold not run (optional)' };
  try {
    // Best-effort: a SKILL.md that names a provider key is dormant in keyless
    // mode. Deep provider matrices live in `gbrain skillpack check`.
    const skillFiles: string[] = [];
    const walk = (d: string, depth: number): void => {
      if (depth > 3) return;
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(p, depth + 1);
        else if (name === 'SKILL.md') skillFiles.push(p);
      }
    };
    walk(dir, 0);
    if (skillFiles.length === 0) return { id, ok: true, detail: 'skills/ present, no SKILL.md files yet' };
    const providerHint = /OPENAI_API_KEY|ANTHROPIC_API_KEY|VOYAGE_API_KEY|api[_ -]?key/i;
    const inert = caps.mode === 'keyless'
      ? skillFiles.filter((p) => {
          try {
            return providerHint.test(readFileSync(p, 'utf8'));
          } catch {
            return false;
          }
        }).length
      : 0;
    if (inert > 0) {
      return { id, ok: true, warn: true, detail: `${inert}/${skillFiles.length} skill(s) reference provider keys and are dormant in keyless mode — one key wakes them (see the capability report)` };
    }
    return { id, ok: true, detail: `${skillFiles.length} skill(s) installed${caps.mode === 'keyless' ? ', none blocked on API keys' : ''}` };
  } catch (e) {
    return { id, ok: true, warn: true, detail: `inert-skill scan failed: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Persistence [B2]
// ---------------------------------------------------------------------------

export const VERIFY_SNAPSHOTS_KEPT = 5;

function persistVerifyRun(gbrainHomeDir: string, payload: { ts: string; ok: boolean; checks: VerifyCheck[] }): void {
  try {
    const dir = join(gbrainHomeDir, 'bootstrap');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `verify-${payload.ts.replace(/[:.]/g, '-')}.json`;
    // tmp+rename (the writeReceipt pattern): a killed verify never leaves a
    // torn snapshot for status/doctor to trip on. The .tmp-* name does not
    // match the retention regex, so a leaked tmp is never counted as a run.
    const dest = join(dir, name);
    const tmp = `${dest}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, dest);
    // Keep the newest VERIFY_SNAPSHOTS_KEPT.
    const runs = readdirSync(dir).filter((n) => /^verify-.*\.json$/.test(n)).sort().reverse();
    for (const stale of runs.slice(VERIFY_SNAPSHOTS_KEPT)) {
      try {
        rmSync(join(dir, stale), { force: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* snapshot telemetry never fails a verify */
  }
}

// ---------------------------------------------------------------------------
// verifyWorkspace
// ---------------------------------------------------------------------------

export async function verifyWorkspace(
  engine: BrainEngine,
  ws: string,
  opts: VerifyOpts = {},
): Promise<VerifyReport> {
  let sourceId = opts.sourceId ?? 'workspace';
  const gbrainHomeDir = opts.gbrainHomeDir ?? resolveGbrainHome();
  const caps = opts.capabilities ?? detectCapabilities();

  const checks: VerifyCheck[] = [];

  checks.push(await checkDoctorGreen(engine));
  const engineHealthy = checks.find((c) => c.id === 'doctor_green')?.ok === true;

  let sourceRegistered = true;
  if (engineHealthy) {
    // Transient-engine work while we hold the engine (before/independent of
    // host registration): the CX-P1.1 visibility posture and the source-id
    // collision resolution both need the config/sources plane.
    checks.push(await ensureDefaultVisibilityPosture(engine));
    const collision = await resolveSourceIdCollision(engine, ws);
    if (collision.sourceId !== null) sourceId = collision.sourceId;
    if (collision.check !== null) checks.push(collision.check);
    // #4328 — registration probe. Probe writes against an UNREGISTERED source
    // die on their sources FK with a raw constraint error that names nothing a
    // user can act on. Detect the gap up front so the roundtrip/hooks-smoke
    // report the one command that fixes it instead. Probe failure fails OPEN
    // (the roundtrip owns surfacing real engine errors).
    try {
      const rows = await engine.executeRaw<{ one: number }>(`SELECT 1 AS one FROM sources WHERE id = $1`, [sourceId]);
      sourceRegistered = rows.length > 0;
    } catch {
      sourceRegistered = true;
    }
  }

  checks.push(checkTokenSweep(ws));
  checks.push(checkByteFloors(ws));
  checks.push(checkWritebackContract(ws));
  checks.push(checkSecretScan(ws));
  checks.push(checkDenyGlobs(ws));
  checks.push(await checkRepoPrivacy(ws));
  checks.push(checkExecutionEnvironment());
  checks.push(checkMcpJsonHygiene(ws));
  checks.push(checkHookCarrierOverlap(ws));

  // Round-trip family only makes sense on a reachable engine. The
  // embedding-plane check (#4287) runs FIRST so a plane split gets its named
  // diagnosis before the roundtrip's put surfaces the raw dimension error —
  // and so a keyless-passing roundtrip can never certify a brain whose keyed
  // writes all fail.
  if (engineHealthy && !sourceRegistered) {
    checks.push(await checkEmbeddingPlane(engine, caps));
    // #4328 — a put against the unregistered source would only surface the
    // raw FK constraint text. Name the actual gap + the one-command fix.
    checks.push({
      id: 'roundtrip',
      ok: false,
      detail:
        `skipped — source '${sourceId}' is not registered in this brain, so probe writes cannot land. ` +
        `Register it (gbrain sources add ${sourceId} --path ${join(ws, 'brain')}) and re-run \`gbrain bootstrap verify\`.`,
    });
  } else if (engineHealthy) {
    checks.push(await checkEmbeddingPlane(engine, caps));
    const rt = await runRoundtrip(engine, ws, sourceId, { ...opts, capabilities: caps });
    checks.push(...rt.checks);
  } else {
    checks.push({ id: 'roundtrip', ok: false, detail: 'skipped — engine probe failed (see doctor_green)' });
  }

  checks.push({ id: 'capability_report', ok: true, detail: `${caps.mode} mode / ${caps.search} search` });
  checks.push(checkMcpSurface());

  if (opts.skipHooksSmoke) {
    checks.push({ id: 'hooks_smoke', ok: true, detail: 'skipped by caller' });
  } else if (!sourceRegistered) {
    // #4328 — the smoke binds GBRAIN_SOURCE to the workspace source; against
    // an unregistered id it can only rediscover the roundtrip's finding.
    checks.push({ id: 'hooks_smoke', ok: true, detail: `skipped — source '${sourceId}' is not registered (see roundtrip)` });
  } else {
    checks.push(await checkHooksSmoke(engine, ws, sourceId));
  }

  checks.push(checkPushProbe(ws));
  checks.push(checkInertSkills(ws, caps));
  const tourCheck = { id: 'first_run_tour', ok: true, detail: 'three scripted prompts appended to the report' };
  checks.push(tourCheck);

  const ok = checks.every((c) => c.ok || c.warn === true);
  if (!ok) tourCheck.detail = 'tour withheld — prints on PASS';

  const ts = new Date().toISOString();
  persistVerifyRun(gbrainHomeDir, { ts, ok, checks });

  const lines: string[] = [];
  lines.push(`gbrain bootstrap verify — ${ok ? 'PASS' : 'FAIL'} (${ts})`);
  for (const c of checks) {
    const mark = c.ok && !c.warn ? 'ok  ' : c.warn ? 'warn' : 'FAIL';
    lines.push(`  [${mark}] ${c.id}: ${c.detail}`);
  }
  lines.push('');
  lines.push(renderCapabilityReport(caps));
  lines.push('');
  // The tour celebrates a WORKING install — under a FAIL banner it reads as
  // a mixed signal ("broken, but go enjoy it"). Gate the report lines on ok;
  // the returned `tour` array (and --json field) stays unconditional so
  // machine consumers keep a stable shape.
  const handoff = buildHandoff(ws);
  if (ok) {
    lines.push('First-run tour — have your human RESTART the session first');
    lines.push('(a fresh session proves the files and the brain, not this chat),');
    lines.push('then try these three prompts in order:');
    FIRST_RUN_TOUR.forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));
    lines.push('');
    for (const h of handoff) lines.push(h);
  } else {
    lines.push('Fix the FAIL checks above and re-run — the first-run tour prints on PASS.');
  }

  return { ok, checks, report: lines.join('\n'), capability: caps, tour: [...FIRST_RUN_TOUR], handoff };
}

/**
 * The post-tour hand-off block [OOBE]: the two things a fresh user must walk
 * away UNDERSTANDING, in priority order —
 *   1. OWNERSHIP: the brain is markdown in a repo THEY own (or local-only,
 *      with the one command that gives it a durable home). Ownership is the
 *      trust story; say the URL, say what owning it means.
 *   2. THE ONE NEXT ACTION: run the cold-start skill. An empty brain is a
 *      database; every flagship skill (book-mirror, briefings, meeting prep)
 *      only becomes magical once the brain holds the user's real life —
 *      cold-start is the designed filler (Gmail/calendar/contacts via
 *      ClawVisor, or offline archives), one consented phase at a time.
 * Returned unconditionally in the machine shape (like `tour`); printed in
 * the report only on PASS. Relay it to the human verbatim.
 */
export function buildHandoff(ws: string): string[] {
  const origin = gitOriginUrl(ws);
  const ownership = origin
    ? [
        `What you own: every memory your agent keeps is a markdown file in YOUR private repo — ${origin}.`,
        'Read it any time, take it to a second machine (`gbrain bootstrap attach`), or delete it and the brain is gone. It is yours.',
      ]
    : [
        'What you own: your agent\'s memory is markdown on this machine only (no remote yet).',
        'Run `gbrain bootstrap repo` any time to give it a private GitHub home you own — readable, portable, deletable.',
      ];
  return [
    ...ownership,
    '',
    'Fill it next: an empty brain is a database; a filled one is a memory.',
    'Ask your agent to run the cold-start skill — it imports your real life',
    '(Gmail, calendar, contacts via ClawVisor, an OAuth vault so the agent never',
    'holds raw tokens; or offline archives like Google Takeout), one consented',
    'phase at a time. Each phase is independently valuable — stop whenever.',
  ];
}
