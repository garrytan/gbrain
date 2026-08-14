/**
 * repo-visibility.ts — ONE repo-visibility verdict for every consumer
 * (workspace-push gate [G8], bootstrap repo/verify/status probes), replacing
 * three drifted probes (TODOS ~5097). Engine-free; every IO seam injectable.
 *
 * Why a ladder and not one gh call: the previous probe (`gh repo view`, a
 * GraphQL call) is structurally unavailable in cloud sandboxes — their GitHub
 * proxy pins GraphQL to a fixed operation set and 403s everything else, even
 * with a user-supplied token — which silently converted every hook push into
 * `refused_visibility`. REST is the sanctioned surface, and pure git protocol
 * works anywhere `git push` works.
 *
 *   rung 1  REST     `gh api repos/{owner}/{repo}` → .private   (github.com)
 *   rung 2  authed   `git ls-remote <url> HEAD`    → exists + readable
 *   rung 3  anon     GET <repo>/info/refs?service=git-upload-pack, no auth
 *
 * Verdict matrix (fail-closed BOTH directions — see [D4]/[D14] below):
 *   rest true                        → private/rest
 *   rest false                       → public/rest        (refuse)
 *   rung2 ok + rung3 attributed 401  → private/git-protocol
 *   rung2 ok + rung3 proven 200      → public/git-protocol (refuse) — unless a
 *                                      credential-injecting proxy makes the
 *                                      "anonymous" probe ambiguous → unverifiable
 *   anything else                    → unverifiable        (refuse, with rung log)
 *
 * [D4]  A 200 counts as PUBLIC only with advertisement proof (content-type
 *       `application/x-git-upload-pack-advertisement` or the pkt-line body
 *       prefix). SSO-fronted self-hosted servers answer 200 with an HTML
 *       login page — that must read `unverifiable`, never a false "PUBLIC".
 * [D14] A 401/404 counts as PRIVATE-signal only with origin attribution
 *       (`www-authenticate` challenge; github.com additionally recognized by
 *       realm/request-id headers). The private verdict AUTHORIZES pushing, so
 *       an auth-demanding middlebox that 401s all anonymous traffic must not
 *       launder a public repo into "private".
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureGbrainHome } from './gbrain-home.ts';
import { durableSsrfFlags } from './git-remote.ts';
import { isCredentialInjectingProxy } from './execution-env.ts';

// ── Subprocess seam (canonical home; bootstrap/repo.ts re-exports) ─────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable subprocess seam. argv[0] is the binary; never a shell string. */
export type ExecRunner = (argv: string[]) => Promise<ExecResult>;

/** Default runner: Bun.spawn, both streams piped, spawn failure → code 127.
 * GIT_TERMINAL_PROMPT=0 so an unauthenticated git can never hang on a prompt. */
export const defaultRunner: ExecRunner = async (argv: string[]): Promise<ExecResult> => {
  try {
    const proc = Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message };
  }
};

/** Race a runner call against a wall-clock cap. On timeout the rung reports
 * code 124 and the ladder degrades — a hung network probe must never hang a
 * push child. (The raced process is left to die on its own; every rung's
 * default runner disables interactive prompts, so hangs are network-bound.) */
async function runWithTimeout(runner: ExecRunner, argv: string[], ms: number): Promise<ExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ExecResult>((resolve) => {
    timer = setTimeout(() => resolve({ code: 124, stdout: '', stderr: `timeout after ${ms}ms` }), ms);
  });
  try {
    return await Promise.race([runner(argv), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Canonical remote-URL parser (union of the three prior grammars) ────────

/**
 * Parse `{owner, repo}` from a github.com remote URL. Accepts the https form
 * (with or without `.git` / trailing slash), the scp-like form
 * (`git@github.com:o/r`), and `ssh://git@github.com/o/r`.
 */
export function parseGithubOwnerRepo(url: string): { owner: string; repo: string } | null {
  const s = url.trim();
  let m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s);
  if (!m) m = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Convenience: the combined `owner/repo` string, or null. */
export function githubOwnerRepoString(url: string): string | null {
  const p = parseGithubOwnerRepo(url);
  return p ? `${p.owner}/${p.repo}` : null;
}

/**
 * The anonymous smart-HTTP probe URL for an https origin, or null when the
 * origin has no https probe surface (scp/ssh non-github, file paths).
 * github.com ssh/scp origins are converted to their https equivalent.
 * URL userinfo is STRIPPED: an origin with embedded credentials would make
 * the "anonymous" probe authenticated, misreading a private repo as public.
 */
export function anonProbeUrl(originUrl: string): string | null {
  const gh = parseGithubOwnerRepo(originUrl);
  if (gh) return `https://github.com/${gh.owner}/${gh.repo}.git/info/refs?service=git-upload-pack`;
  const s = originUrl.trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(s)) return null;
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    return `${u.toString().replace(/\/+$/, '')}/info/refs?service=git-upload-pack`;
  } catch {
    return null; // unparseable https-looking string — no probe surface
  }
}

/** True when a gh stderr/body is a 403 authored by a sandbox egress proxy
 * (session scoping), as opposed to a real GitHub API 403. One predicate for
 * the three call sites that must keep the HTTP-403 pre-check and the
 * classification paired. */
export function isProxyBlocked403(text: string): boolean {
  return /HTTP 403/i.test(text) && classifyGh403(text) === 'proxy';
}

// ── gh 403 classification ───────────────────────────────────────────────────

export type Gh403Class = 'github' | 'proxy' | 'unknown';

/**
 * Classify a 403 body/stderr: a real GitHub API error is JSON carrying
 * `message` + `documentation_url`; sandbox egress proxies answer with
 * text/plain or non-GitHub JSON ("not enabled for this session",
 * x-deny-reason). The class steers the user message — "attach the repo to
 * this session" vs "check your token" — and MUST NOT gate the verdict.
 */
export function classifyGh403(body: string): Gh403Class {
  const jsonStart = body.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(body.slice(jsonStart)) as Record<string, unknown>;
      if (typeof parsed.message === 'string') {
        if ('documentation_url' in parsed) return 'github';
        return 'proxy'; // JSON error without GitHub's shape — proxy-authored
      }
    } catch {
      /* not JSON → fall through */
    }
  }
  if (/not enabled for this session|x-deny-reason|host_not_allowed|access denied by the .*proxy/i.test(body)) {
    return 'proxy';
  }
  return 'unknown';
}

// ── The ladder ──────────────────────────────────────────────────────────────

export type VisibilityVia = 'rest' | 'git-protocol';

export interface RungResult {
  rung: 'rest' | 'authed-ls-remote' | 'anon-refs';
  outcome: string;
}

export type RepoVisibilityVerdict =
  | { verdict: 'private'; via: VisibilityVia; detail: string; rungs: RungResult[] }
  | { verdict: 'public'; via: VisibilityVia; detail: string; rungs: RungResult[] }
  | { verdict: 'unverifiable'; detail: string; rungs: RungResult[] };

export interface VerifyRepoVisibilityOpts {
  originUrl: string;
  /** Run git with this repo's config (credential helpers). Recommended. */
  repoDir?: string;
  runner?: ExecRunner;
  fetchImpl?: typeof fetch;
  /** Environment for the proxy-signature check (default process.env). */
  env?: Record<string, string | undefined>;
  /** Per-rung wall-clock cap (default 15s). */
  timeoutMs?: number;
}

const ADVERTISEMENT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
/** pkt-line advertisement prefix: 4 hex length digits then the service line. */
const ADVERTISEMENT_BODY_RE = /^[0-9a-f]{4}# service=git-upload-pack/;

function rungLog(rungs: RungResult[]): string {
  return rungs.map((r) => `${r.rung}: ${r.outcome}`).join('; ');
}

/** The actionable line for proxy-ambiguous / unverifiable outcomes. Spelled
 * once so push, verify, and status degrade with the same instruction. */
export const UNVERIFIED_REMOTE_HINT =
  'confirm the repo is private in the GitHub UI, then set GBRAIN_ALLOW_UNVERIFIED_REMOTE=1 ' +
  '(or `gbrain config set push.allow_unverified_remote true`) to push anyway';

export async function verifyRepoVisibility(opts: VerifyRepoVisibilityOpts): Promise<RepoVisibilityVerdict> {
  const runner = opts.runner ?? defaultRunner;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const rungs: RungResult[] = [];
  const url = opts.originUrl.trim();
  const gh = parseGithubOwnerRepo(url);

  // Rung 1 — REST (github.com origins only). NEVER GraphQL: `gh repo view`
  // rides GraphQL, which cloud proxies pin to a fixed operation set.
  if (gh) {
    const res = await runWithTimeout(runner, ['gh', 'api', `repos/${gh.owner}/${gh.repo}`, '--jq', '.private'], timeoutMs);
    const out = res.stdout.trim();
    if (res.code === 0 && out === 'true') {
      rungs.push({ rung: 'rest', outcome: 'private' });
      return { verdict: 'private', via: 'rest', detail: `${gh.owner}/${gh.repo} verified private via REST`, rungs };
    }
    if (res.code === 0 && out === 'false') {
      rungs.push({ rung: 'rest', outcome: 'public' });
      return { verdict: 'public', via: 'rest', detail: `${gh.owner}/${gh.repo} is PUBLIC (REST)`, rungs };
    }
    if (res.code === 127) {
      rungs.push({ rung: 'rest', outcome: 'gh not installed' });
    } else if (/HTTP 403/i.test(res.stderr)) {
      rungs.push({
        rung: 'rest',
        outcome: isProxyBlocked403(res.stderr)
          ? 'blocked by an egress proxy (repo not attached to this session) — falling back to git protocol'
          : `403 (${classifyGh403(res.stderr)}) — falling back to git protocol`,
      });
    } else {
      rungs.push({ rung: 'rest', outcome: `failed (${(res.stderr.trim() || `exit ${res.code}`).slice(0, 120)})` });
    }
  } else {
    rungs.push({ rung: 'rest', outcome: 'not a github.com origin — skipped' });
  }

  // Rung 2 — authed existence: the repo's own credential config answers
  // "does this origin exist and can OUR credentials read it". Hardened like
  // every other remote-touching git call: SSRF config flags (no ext helpers,
  // no redirect-follow, file transport only behind the test/self-hosted env
  // escape) and end-of-options so a dash-prefixed origin can never be parsed
  // as an option (the upload-pack command-execution class).
  const lsArgv = [
    'git',
    ...(opts.repoDir ? ['-C', opts.repoDir] : []),
    ...durableSsrfFlags(),
    'ls-remote',
    '--end-of-options',
    url,
    'HEAD',
  ];
  const ls = await runWithTimeout(runner, lsArgv, timeoutMs);
  if (ls.code !== 0) {
    rungs.push({ rung: 'authed-ls-remote', outcome: `failed (${(ls.stderr.trim() || `exit ${ls.code}`).slice(0, 120)})` });
    return {
      verdict: 'unverifiable',
      detail: `origin not readable with current credentials — a push would fail anyway (${rungLog(rungs)})`,
      rungs,
    };
  }
  rungs.push({ rung: 'authed-ls-remote', outcome: 'ok (exists + readable)' });

  // Rung 3 — anonymous probe.
  const probeUrl = anonProbeUrl(url);
  if (!probeUrl) {
    rungs.push({ rung: 'anon-refs', outcome: 'no https probe surface for this origin' });
    return { verdict: 'unverifiable', detail: `origin readable but privacy unprovable (${rungLog(rungs)}) — ${UNVERIFIED_REMOTE_HINT}`, rungs };
  }
  let status = 0;
  let contentType = '';
  let wwwAuthenticate = '';
  let githubAttributed = false;
  let bodyPrefix = '';
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // redirect: manual — a redirected probe proves nothing about THIS origin
      // (and following it would extend the request surface); 3xx falls through
      // to the unexpected-status arm → unverifiable, fail-closed.
      const res = await fetchImpl(probeUrl, { redirect: 'manual', signal: ctl.signal });
      status = res.status;
      contentType = res.headers.get('content-type') ?? '';
      wwwAuthenticate = res.headers.get('www-authenticate') ?? '';
      githubAttributed = res.headers.has('x-github-request-id');
      bodyPrefix = (await res.text()).slice(0, 64);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    rungs.push({ rung: 'anon-refs', outcome: `network error (${(e as Error).message.slice(0, 80)})` });
    return { verdict: 'unverifiable', detail: `anonymous probe unreachable (${rungLog(rungs)}) — ${UNVERIFIED_REMOTE_HINT}`, rungs };
  }

  if (status === 401 || status === 404) {
    // [D14] attribution required before the push-authorizing PRIVATE verdict.
    // RFC 7235 makes www-authenticate mandatory on EVERY 401 — a middlebox's
    // included — so the challenge alone is NEVER proof. github.com origins
    // require the GitHub request-id header. For NON-github origins there is no
    // trustable attribution signal at all (a spoofing/inspecting middlebox
    // 401s identically to a real private server), so a 401 there is
    // `unverifiable` — the operator confirms via the escape hatch rather than
    // us laundering a possibly-public repo into a push authorization. Both
    // adversarial reviewers flagged the prior "challenge ⇒ private" as a
    // public-repo-exfil path; fail closed.
    const attributed = gh !== null && githubAttributed;
    if (attributed) {
      rungs.push({ rung: 'anon-refs', outcome: `${status} with GitHub-attributed auth challenge (not anonymously readable)` });
      return {
        verdict: 'private',
        via: 'git-protocol',
        detail: `origin exists, reads with credentials, and refuses anonymous access (${rungLog(rungs)})`,
        rungs,
      };
    }
    const why = gh !== null
      ? `${status} without GitHub attribution (x-github-request-id) — possible middlebox`
      : `${status} on a non-github origin — no trustable attribution signal`;
    rungs.push({ rung: 'anon-refs', outcome: `${why}, not trusted as a privacy signal` });
    return { verdict: 'unverifiable', detail: `un-attributed ${status} on the anonymous probe (${rungLog(rungs)}) — ${UNVERIFIED_REMOTE_HINT}`, rungs };
  }

  if (status === 200) {
    // [D4] advertisement proof required before the "public" verdict.
    const proven =
      contentType.toLowerCase().includes(ADVERTISEMENT_CONTENT_TYPE) || ADVERTISEMENT_BODY_RE.test(bodyPrefix);
    if (!proven) {
      rungs.push({ rung: 'anon-refs', outcome: '200 without a git advertisement (SSO/login page?) — not trusted as a public signal' });
      return { verdict: 'unverifiable', detail: `anonymous 200 without advertisement proof (${rungLog(rungs)}) — ${UNVERIFIED_REMOTE_HINT}`, rungs };
    }
    if (isCredentialInjectingProxy(env)) {
      // The "anonymous" request may have been silently authenticated by the
      // sandbox proxy — a private repo would ALSO read 200 here. Ambiguous.
      rungs.push({ rung: 'anon-refs', outcome: '200 advertisement behind a credential-injecting proxy — ambiguous' });
      return {
        verdict: 'unverifiable',
        detail: `cannot prove privacy from inside this sandbox's authenticated proxy (${rungLog(rungs)}) — ${UNVERIFIED_REMOTE_HINT}`,
        rungs,
      };
    }
    rungs.push({ rung: 'anon-refs', outcome: '200 with a git advertisement — anonymously clonable' });
    return { verdict: 'public', via: 'git-protocol', detail: `origin is anonymously readable (${rungLog(rungs)})`, rungs };
  }

  rungs.push({ rung: 'anon-refs', outcome: `unexpected HTTP ${status}` });
  return { verdict: 'unverifiable', detail: `anonymous probe answered HTTP ${status} (${rungLog(rungs)}) — ${UNVERIFIED_REMOTE_HINT}`, rungs };
}

// ── Verdict cache [D11] ─────────────────────────────────────────────────────
//
// PRIVATE verdicts only, 1h TTL, keyed on the exact origin URL. `public` and
// `unverifiable` are NEVER cached: failures must re-verify every push so a
// fixed repo unblocks on the next turn, while a private→public flip is
// honored at most one TTL late (deliberate owner action; the secret-scan gate
// still runs on every push). Kills the per-turn network cost of the
// cloud-sandbox debounce-0 push cadence.

export const VISIBILITY_CACHE_TTL_MS = 60 * 60 * 1000;

/** Cache key = origin URL with any userinfo (`user:pat@`) stripped — a PAT in
 * an https remote must never be persisted into the on-disk cache file. */
function cacheKey(originUrl: string): string {
  try {
    const u = new URL(originUrl);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return originUrl; // scp/ssh/file forms carry no URL userinfo
  }
}

interface VisibilityCacheEntry {
  verdict: 'private';
  via: VisibilityVia;
  verified_at: string;
}

export function visibilityCachePath(): string {
  return join(ensureGbrainHome(), 'bootstrap', 'visibility-cache.json');
}

/** A fresh cached PRIVATE verdict for this origin, or null. */
export function readCachedPrivateVerdict(
  originUrl: string,
  opts: { now?: number; path?: string } = {},
): RepoVisibilityVerdict | null {
  const now = opts.now ?? Date.now();
  try {
    const raw = readFileSync(opts.path ?? visibilityCachePath(), 'utf8');
    const map = JSON.parse(raw) as Record<string, VisibilityCacheEntry>;
    const entry = map[cacheKey(originUrl)];
    if (!entry || entry.verdict !== 'private') return null;
    const at = Date.parse(entry.verified_at);
    if (!Number.isFinite(at) || now - at > VISIBILITY_CACHE_TTL_MS) return null;
    return {
      verdict: 'private',
      via: entry.via,
      detail: `verified private ${entry.via === 'rest' ? 'via REST' : 'via git protocol'} at ${entry.verified_at} (cached)`,
      rungs: [],
    };
  } catch {
    return null; // missing/corrupt cache is a miss, never an error
  }
}

/** Record a PRIVATE verdict (no-op for any other verdict). Prunes expired
 * entries; tolerant of a corrupt existing file (starts fresh). */
export function writeVisibilityCache(
  originUrl: string,
  verdict: RepoVisibilityVerdict,
  opts: { now?: number; path?: string } = {},
): void {
  if (verdict.verdict !== 'private') return;
  const now = opts.now ?? Date.now();
  const path = opts.path ?? visibilityCachePath();
  let map: Record<string, VisibilityCacheEntry> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, VisibilityCacheEntry>;
    for (const [k, v] of Object.entries(parsed)) {
      const at = Date.parse(v?.verified_at ?? '');
      if (v?.verdict === 'private' && Number.isFinite(at) && now - at <= VISIBILITY_CACHE_TTL_MS) map[k] = v;
    }
  } catch {
    map = {};
  }
  map[cacheKey(originUrl)] = { verdict: 'private', via: verdict.via, verified_at: new Date(now).toISOString() };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* cache write failure is never an error — next push just re-verifies */
  }
}

