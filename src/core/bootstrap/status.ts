/**
 * `gbrain bootstrap status` — phase detection, the install log, and the
 * support blob (agent-bootstrap plan: D5, B1, B5, C1 skew check).
 *
 * [D5] THE phase list is defined ONCE, here, in TS. `bootstrap status --json`
 * emits it; BOOTSTRAP_FOR_AGENTS.md defers to it ("follow status's phase
 * list"); CI checks the runbook's phase names against this array. Do not
 * duplicate the list anywhere else.
 *
 * Detection is artifact-first: each phase's `detect(ws, ctx)` looks at what
 * actually exists on disk (config, interview state, manifest, receipt,
 * settings, verify snapshots) — the append-only install log (B1) is
 * TELEMETRY, never the source of truth for "did this phase run", because a
 * crashed run writes artifacts without a log line and the status command is
 * exactly the resume entrypoint for that case.
 *
 * [B1] `<gbrain home>/bootstrap/install.jsonl` — one appended line per
 * dispatcher subcommand invocation ({ts, phase, outcome, duration_ms,
 * binary_version, harness?, workspace}). Append-only, never throws.
 *
 * [B5] `statusReport().support` is the blob AGENTS.md tells the agent to
 * relay verbatim on any "something's broken" report: workspace, binary
 * version, engine, harness registrations (from the receipt), last verify
 * summary (newest verify-*.json), last push (push-status.json), hook
 * failure rate (trailing heartbeat window).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { VERSION } from '../../version.ts';
import { loadConfigFileOnly } from '../config.ts';
import { binaryOnPath, detectExecutionEnvironment, type ExecutionEnvironment } from '../execution-env.ts';
import { resolveGbrainHome } from '../gbrain-home.ts';
import { githubOwnerRepoString, isProxyBlocked403 } from '../repo-visibility.ts';

import { BOOTSTRAP_TEMPLATES } from './assets.ts';
import {
  readManifest,
  readReceipt,
  type InstallReceipt,
  type ManifestState,
} from './format.ts';
import { interviewStatePath, status as interviewStatus } from './interview.ts';
import {
  CLAUDE_COMMITTED_SETTINGS_FILE_RELPATH,
  CLAUDE_SETTINGS_FILE_RELPATH,
  GBRAIN_HOOK_MARKER_KEY,
  GBRAIN_HOOK_MARKER_VALUE,
} from './host-specs.ts';

// ---------------------------------------------------------------------------
// The phase list [D5] — single TS source of truth
// ---------------------------------------------------------------------------

export const BOOTSTRAP_PHASE_IDS = [
  'preflight',
  'engine',
  'interview',
  'render',
  'skills',
  'wire',
  'repo',
  'verify',
] as const;

export type BootstrapPhaseId = (typeof BOOTSTRAP_PHASE_IDS)[number];

export type PhaseState = 'done' | 'pending' | 'partial' | 'skipped';

export interface PhaseStatus {
  id: BootstrapPhaseId;
  title: string;
  state: PhaseState;
  /** The exact next action when this phase is not done. */
  resume_hint: string;
  detail?: string;
}

/** Everything a detector may look at, computed once per statusReport. */
interface DetectCtx {
  gbrainHomeDir: string;
  manifest: ManifestState;
  receipt: InstallReceipt | null;
  configPresent: boolean;
  lastVerify: VerifySummary | null;
}

interface PhaseSpec {
  id: BootstrapPhaseId;
  title: string;
  resume_hint: string;
  detect: (ws: string, ctx: DetectCtx) => { state: PhaseState; detail?: string };
}


/** The workspace's `origin` remote URL, or null (not a repo / no origin).
 * Shared with verify.ts's origin-probe sites — one 5s-timeout idiom. */
export function gitOriginUrl(ws: string): string | null {
  try {
    const out = execFileSync('git', ['-C', ws, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Template-door privacy gate
// ---------------------------------------------------------------------------

export type OriginVisibility =
  | { verdict: 'private' }
  | { verdict: 'public'; detail: string }
  | { verdict: 'unknown'; detail: string };

/** Probe an origin's visibility via REST — `gh api repos/{owner}/{repo}` —
 * NEVER `gh repo view` (GraphQL under the hood; cloud sandbox proxies pin
 * GraphQL to a fixed operation set and 403 it even with a user token). Sync
 * by contract: this runs inside the sync phase-detect chain, so the full
 * async ladder lives in verify/push; status keeps the cheap REST answer.
 * gh missing / offline / non-GitHub / 403 → 'unknown', never an invented
 * answer; a proxy-shaped 403 names the real fix. */
export function probeOriginVisibility(origin: string): OriginVisibility {
  const ownerRepo = githubOwnerRepoString(origin);
  if (ownerRepo === null) {
    // Never send a non-github origin string into a REST path — self-hosted
    // hostnames (or URL-embedded credentials) must not reach api.github.com.
    return { verdict: 'unknown', detail: 'origin is not a github.com URL — cannot verify via REST' };
  }
  try {
    // env: process.env — Bun's execFileSync otherwise resolves the binary
    // against the STARTUP env snapshot, making PATH-shimmed test fakes (and
    // any runtime PATH change) invisible (the workspace-push.ts precedent).
    const out = execFileSync('gh', ['api', `repos/${ownerRepo}`, '--jq', '.private'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      env: process.env,
    })
      .toString()
      .trim();
    if (out === 'true') return { verdict: 'private' };
    if (out === 'false') return { verdict: 'public', detail: `${origin} is PUBLIC` };
    return { verdict: 'unknown', detail: `gh returned unexpected output: ${out.slice(0, 80)}` };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (err?.code === 'ENOENT') {
      return { verdict: 'unknown', detail: 'gh CLI not installed — cannot verify origin visibility' };
    }
    const stderr = (err?.stderr ?? '').toString();
    if (isProxyBlocked403(stderr)) {
      return {
        verdict: 'unknown',
        detail: 'GitHub REST blocked by this sandbox\'s egress proxy (repo not attached to the session) — push-time verification falls back to git protocol',
      };
    }
    return { verdict: 'unknown', detail: `gh api failed (${(err?.message ?? 'unknown').slice(0, 120)})` };
  }
}

/** True when either hook carrier — the gitignored `settings.local.json` OR
 * the committed `.claude/settings.json` [D12] — carries a gbrain marker. */
export function hooksInstalled(ws: string): boolean {
  try {
    const probe = (relpath: string): boolean => {
      try {
        const raw = readFileSync(join(ws, relpath), 'utf8');
        // Structural probe without a full merge: the marker key/value pair is
        // the idempotency contract host-specs.ts pins — substring is honest.
        return raw.includes(`"${GBRAIN_HOOK_MARKER_KEY}"`) && raw.includes(`"${GBRAIN_HOOK_MARKER_VALUE}"`);
      } catch {
        return false;
      }
    };
    return probe(CLAUDE_SETTINGS_FILE_RELPATH) || probe(CLAUDE_COMMITTED_SETTINGS_FILE_RELPATH);
  } catch {
    return false;
  }
}

export const PHASES: PhaseSpec[] = [
  {
    id: 'preflight',
    title: 'Toolchain preflight (git, bun, gh)',
    resume_hint: 'install git + gh per the runbook trust rules, then `gh auth login`',
    detect: (_ws) => {
      const git = binaryOnPath('git');
      const gh = binaryOnPath('gh');
      if (git && gh) return { state: 'done' };
      if (git) return { state: 'partial', detail: 'gh (GitHub CLI) not on PATH — needed for the repo phase only' };
      return { state: 'pending', detail: 'git not on PATH' };
    },
  },
  {
    id: 'engine',
    title: 'Local brain engine (gbrain init)',
    resume_hint: 'gbrain init --pglite',
    detect: (_ws, ctx) =>
      ctx.configPresent ? { state: 'done' } : { state: 'pending', detail: 'no gbrain config — engine not initialized' },
  },
  {
    id: 'interview',
    title: 'Identity interview (confirmed read-back)',
    resume_hint:
      'gbrain bootstrap interview --init, then --set each answer, then --confirm <hash>. ' +
      'Claude Code and opencode: also record the MCP scope consent (--set MCP_SCOPE <project|user>) BEFORE --confirm',
    detect: (ws) => {
      const exists = existsSync(interviewStatePath(ws));
      const st = interviewStatus(ws);
      if (!st.ok) return { state: 'partial', detail: st.message };
      if (st.complete && st.confirmed) return { state: 'done' };
      if (st.complete) return { state: 'partial', detail: 'answers complete but not confirmed — read them back, then --confirm <hash>' };
      if (st.answered.length > 0 || exists) {
        return { state: 'partial', detail: `missing required: ${st.missingRequired.join(', ') || '(none)'}` };
      }
      return { state: 'pending' };
    },
  },
  {
    id: 'render',
    title: 'Render identity files',
    resume_hint: 'gbrain bootstrap render',
    detect: (ws, ctx) => {
      if (ctx.manifest.state === 'initialized') return { state: 'done' };
      if (ctx.manifest.state === 'template') {
        return { state: 'partial', detail: 'uninitialized template clone — render flips it' };
      }
      if (ctx.manifest.state === 'invalid') {
        return { state: 'partial', detail: `agent.json invalid: ${ctx.manifest.reason}` };
      }
      const present = BOOTSTRAP_TEMPLATES.filter((t) => existsSync(join(ws, t.dest))).length;
      if (present > 0) return { state: 'partial', detail: `${present}/${BOOTSTRAP_TEMPLATES.length} rendered files present, no manifest` };
      return { state: 'pending' };
    },
  },
  {
    id: 'skills',
    title: 'Skill scaffold',
    resume_hint: 'gbrain skillpack scaffold --all',
    detect: (ws, ctx) => {
      const dir = join(ws, 'skills');
      if (existsSync(dir)) {
        try {
          const n = readdirSync(dir).filter((e) => !e.startsWith('.')).length;
          if (n > 0) return { state: 'done', detail: `${n} entr${n === 1 ? 'y' : 'ies'} in skills/` };
          return { state: 'partial', detail: 'skills/ exists but is empty' };
        } catch {
          return { state: 'partial', detail: 'skills/ unreadable' };
        }
      }
      // Skills only make sense after render laid the workspace down.
      return ctx.manifest.state === 'initialized' ? { state: 'pending' } : { state: 'pending', detail: 'runs after render' };
    },
  },
  {
    id: 'wire',
    title: 'Harness wiring (MCP + hooks)',
    // Static, both-harness hint (no detectHarness branching — status may run
    // outside the harness being wired). Advisory prose; the grep pins in
    // scripts/check-bootstrap-templates.sh §(e) are the enforcement.
    resume_hint:
      'gbrain bootstrap hooks --harness <claude-code|codex|opencode> — MCP scope consent applies on ' +
      'Claude Code and opencode (recorded during the interview, pre-confirm; opencode defaults to ' +
      'user-global — the sharing-safe choice, since it spawns project-config servers with no trust gate); ' +
      'Codex registrations are always user-global (no scope flag)',
    detect: (ws, ctx) => {
      const regs = ctx.receipt?.registrations ?? [];
      if (regs.length > 0) {
        // A registration whose detail carries 'mcp' ('mcp' or 'mcp+hooks')
        // means MCP actually registered. A 'hooks'-only detail means the host
        // binary was missing at wire time (hooks landed, MCP did not) — the
        // phase is PARTIAL, not done, so a resuming agent re-runs it once the
        // CLI is on PATH instead of trusting a false "done".
        const mcpRegistered = regs.some((r) => (r.detail ?? '').includes('mcp'));
        if (mcpRegistered) {
          return { state: 'done', detail: regs.map((r) => `${r.host} (${r.scope})`).join(', ') };
        }
        return {
          state: 'partial',
          detail: 'hooks installed but MCP not registered (the harness CLI was not on PATH) — ' +
            're-run `gbrain bootstrap hooks --harness <claude-code|codex>` once it is',
        };
      }
      if (hooksInstalled(ws)) return { state: 'done', detail: 'hooks present in .claude/settings.local.json' };
      return { state: 'pending' };
    },
  },
  {
    id: 'repo',
    title: 'Private GitHub repo (durable body)',
    resume_hint: 'gbrain bootstrap repo (or stay local-only; re-run any time)',
    detect: (ws, ctx) => {
      const repoUrl = (ctx.receipt as (InstallReceipt & { repo_url?: string }) | null)?.repo_url;
      if (repoUrl) return { state: 'done', detail: repoUrl };
      const origin = gitOriginUrl(ws);
      if (origin) return { state: 'partial', detail: `origin exists (${origin}) but not yet pushed — run \`gbrain bootstrap repo\` (adopts an empty repo you created), or \`gbrain bootstrap attach\` for an existing agent clone` };
      return { state: 'pending' };
    },
  },
  {
    id: 'verify',
    title: 'End-to-end verify',
    resume_hint: 'gbrain bootstrap verify',
    detect: (_ws, ctx) => {
      if (!ctx.lastVerify) return { state: 'pending' };
      if (ctx.lastVerify.ok) return { state: 'done', detail: `last verify ${ctx.lastVerify.ts}` };
      return {
        state: 'partial',
        detail: `last verify FAILED (${ctx.lastVerify.ts}): ${ctx.lastVerify.checks_failed.join(', ') || 'see snapshot'}`,
      };
    },
  },
];

// Compile-time pin: PHASES covers BOOTSTRAP_PHASE_IDS exactly, in order.
// (Also asserted at runtime by test/bootstrap-status.test.ts.)
void (PHASES satisfies Array<{ id: BootstrapPhaseId }>);

// ---------------------------------------------------------------------------
// Install log [B1]
// ---------------------------------------------------------------------------

export interface InstallLogEntry {
  ts: string;
  phase: string;
  outcome: 'ok' | 'error' | 'aborted';
  duration_ms: number;
  binary_version: string;
  harness?: string;
  workspace: string;
}

export function installLogPath(gbrainHomeDir: string): string {
  return join(gbrainHomeDir, 'bootstrap', 'install.jsonl');
}

/** Append one line. Telemetry never throws [B1]. */
export function appendInstallLog(gbrainHomeDir: string, entry: InstallLogEntry): void {
  try {
    const p = installLogPath(gbrainHomeDir);
    mkdirSync(join(gbrainHomeDir, 'bootstrap'), { recursive: true, mode: 0o700 });
    appendFileSync(p, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    /* telemetry never breaks a subcommand */
  }
}

/** Last `n` entries (oldest → newest); torn lines skipped. */
export function readInstallLog(gbrainHomeDir: string, n = 50): InstallLogEntry[] {
  try {
    const raw = readFileSync(installLogPath(gbrainHomeDir), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: InstallLogEntry[] = [];
    for (const line of lines.slice(-Math.max(0, n))) {
      try {
        out.push(JSON.parse(line) as InstallLogEntry);
      } catch {
        /* torn line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Verify snapshots [B2 read side]
// ---------------------------------------------------------------------------

export interface VerifySummary {
  ts: string;
  ok: boolean;
  checks_failed: string[];
  file: string;
}

/** Newest-first list of persisted verify runs under `<home>/bootstrap/`. */
export function listVerifyRuns(gbrainHomeDir: string): VerifySummary[] {
  const dir = join(gbrainHomeDir, 'bootstrap');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^verify-.*\.json$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
  const out: VerifySummary[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        ts?: string;
        ok?: boolean;
        checks?: Array<{ id: string; ok: boolean; warn?: boolean }>;
      };
      out.push({
        ts: parsed.ts ?? 'unknown',
        ok: parsed.ok === true,
        checks_failed: (parsed.checks ?? []).filter((c) => !c.ok && c.warn !== true).map((c) => c.id),
        file: join(dir, name),
      });
    } catch {
      /* unreadable snapshot — skip */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runbook stamp / skew [C1]
// ---------------------------------------------------------------------------

export const RUNBOOK_FILENAME = 'BOOTSTRAP_FOR_AGENTS.md';
const STAMP_RE = /<!--\s*gbrain-runbook-stamp:\s*([^\s>]+)\s*-->/;

/** The `<!-- gbrain-runbook-stamp: X -->` value from `<dir>/BOOTSTRAP_FOR_AGENTS.md`,
 * or null when the runbook is absent/unstamped (skip — not every workspace
 * keeps the fetched runbook around). */
export function readRunbookStamp(dir: string): string | null {
  try {
    const raw = readFileSync(join(dir, RUNBOOK_FILENAME), 'utf8');
    const m = STAMP_RE.exec(raw);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export interface RunbookSkew {
  runbookStamp: string;
  binaryVersion: string;
}

// ---------------------------------------------------------------------------
// statusReport [D5 + B5]
// ---------------------------------------------------------------------------

export interface StatusSupport {
  workspace: string;
  binary_version: string;
  /** Engine kind from the config file ('pglite' | 'postgres' | null when uninitialized). */
  engine: string | null;
  harness_registrations: Array<{ host: string; scope: string; detail?: string }>;
  last_verify: { ts: string; ok: boolean; checks_failed: string[] } | null;
  last_push: { ts?: string; ok?: boolean; reason?: string } | null;
  /** Hard-error fraction over the trailing heartbeat window; null = no telemetry. */
  hook_failure_rate: number | null;
}

export interface StatusReport {
  workspace: string;
  phases: PhaseStatus[];
  /** Resume hint of the first non-done phase; null when everything is done. */
  next: string | null;
  /** WHERE this install is running [D-cloud]: 'local' | 'cloud-sandbox' |
   * 'ephemeral-container'. Installing agents branch on this — cron is skipped
   * in containers, repo creation is redirected in cloud sandboxes, and the
   * runbook's cloud section keys off it. */
  execution_environment: ExecutionEnvironment;
  runbookSkew?: RunbookSkew;
  /** Template-door privacy gate: set only for an UNINITIALIZED template clone
   * whose origin exists and is not verifiably private. 'public' is a hard
   * stop (the dispatcher exits non-zero — identity files must never land in a
   * public repo); 'unknown' (no gh / offline) is a loud warning, not a fail. */
  privacy_gate?: { verdict: 'public' | 'unknown'; origin: string; detail: string };
  support: StatusSupport;
}

export interface StatusReportOpts {
  gbrainHomeDir?: string;
}

export async function statusReport(ws: string, opts: StatusReportOpts = {}): Promise<StatusReport> {
  const gbrainHomeDir = opts.gbrainHomeDir ?? resolveGbrainHome();

  let config: ReturnType<typeof loadConfigFileOnly> = null;
  try {
    config = loadConfigFileOnly();
  } catch {
    config = null;
  }

  const verifyRuns = listVerifyRuns(gbrainHomeDir);
  const ctx: DetectCtx = {
    gbrainHomeDir,
    manifest: readManifest(ws),
    receipt: readReceipt(gbrainHomeDir),
    configPresent: config !== null,
    lastVerify: verifyRuns[0] ?? null,
  };

  const phases: PhaseStatus[] = PHASES.map((spec) => {
    let state: PhaseState = 'pending';
    let detail: string | undefined;
    try {
      const r = spec.detect(ws, ctx);
      state = r.state;
      detail = r.detail;
    } catch (e) {
      state = 'partial';
      detail = `detection failed: ${(e as Error).message}`;
    }
    return {
      id: spec.id,
      title: spec.title,
      state,
      resume_hint: spec.resume_hint,
      ...(detail !== undefined ? { detail } : {}),
    };
  });

  const firstNotDone = phases.find((p) => p.state !== 'done' && p.state !== 'skipped');
  const next = firstNotDone ? firstNotDone.resume_hint : null;

  // Skew check [C1]: compare the fetched runbook's stamp to this binary.
  const stamp = readRunbookStamp(ws);
  const runbookSkew = stamp !== null && stamp !== VERSION ? { runbookStamp: stamp, binaryVersion: VERSION } : undefined;

  // Template-door privacy gate: a template clone ("Use this template" flow)
  // with a PUBLIC origin must hard-stop BEFORE any identity file lands —
  // status is the resume entrypoint, so the gate lives here. Initialized
  // workspaces get the same protection from verify's repo_privacy check and
  // the push-time deny path.
  let privacyGate: StatusReport['privacy_gate'];
  if (ctx.manifest.state === 'template') {
    const origin = gitOriginUrl(ws);
    if (origin) {
      const probe = probeOriginVisibility(origin);
      if (probe.verdict !== 'private') {
        privacyGate = { verdict: probe.verdict, origin, detail: probe.detail };
      }
    }
  }

  // Support blob [B5]. Push status via the shared per-root reader [D8/D13]:
  // a failing workspace wins over another's success; else the newest record.
  let lastPush: StatusSupport['last_push'] = null;
  try {
    const { readPushStatuses, summarizePushStatuses } = await import('../workspace-push.ts');
    const entries = readPushStatuses();
    const { failing } = summarizePushStatuses(entries);
    const pick = failing[0] ?? entries.sort((a, b) => Date.parse(b.ts ?? '') - Date.parse(a.ts ?? ''))[0];
    if (pick) {
      lastPush = {
        ...(pick.ts !== undefined ? { ts: pick.ts } : {}),
        ...(pick.ok !== undefined ? { ok: pick.ok } : {}),
        ...(pick.reason !== undefined ? { reason: pick.reason } : {}),
      };
    }
  } catch {
    lastPush = null;
  }

  let hookFailureRate: number | null = null;
  try {
    // Lazy import (core→commands, the sweep.ts precedent) — hook.ts is
    // engine-free, and a partially-built tree must not break status.
    const { readHeartbeatTail, HEARTBEAT_FAILURE_WINDOW } = await import('../../commands/hook.ts');
    const tail = await readHeartbeatTail(HEARTBEAT_FAILURE_WINDOW);
    if (tail.length > 0) {
      hookFailureRate = tail.filter((e) => e.outcome === 'error').length / tail.length;
    }
  } catch {
    hookFailureRate = null;
  }

  const support: StatusSupport = {
    workspace: ws,
    binary_version: VERSION,
    engine: config?.engine ?? null,
    harness_registrations: (ctx.receipt?.registrations ?? []).map((r) => ({
      host: r.host,
      scope: r.scope,
      ...(r.detail !== undefined ? { detail: r.detail } : {}),
    })),
    last_verify: ctx.lastVerify
      ? { ts: ctx.lastVerify.ts, ok: ctx.lastVerify.ok, checks_failed: ctx.lastVerify.checks_failed }
      : null,
    last_push: lastPush,
    hook_failure_rate: hookFailureRate,
  };

  return {
    workspace: ws,
    phases,
    next,
    execution_environment: detectExecutionEnvironment(),
    ...(runbookSkew ? { runbookSkew } : {}),
    ...(privacyGate ? { privacy_gate: privacyGate } : {}),
    support,
  };
}
