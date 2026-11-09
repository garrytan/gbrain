/**
 * The stable release channel on the client side (GBRA-175, GBRA-224 W1).
 *
 * A stable release is accepted only with evidence. scripts/promote-stable.ts moves the annotated `stable` tag and, in
 * the same atomic push, commits the evidence record (`stable.json`) to the `stable-record` branch, so a client reads it
 * at a raw URL with no API call and no git. The record names the version, its commit and tree, the soak run (and,
 * from MATRIX_REQUIRED_FROM on, the upgrade-matrix run) and the `known_bad` list of withdrawn versions. A lookup
 * fails one of three ways, each a typed code: `stable_missing` (nothing promoted), `stable_invalid` (a record or tag
 * that does not describe a release with its evidence) and `stable_unreadable` (could not be read; retry). Nothing is
 * installed on any of them, and the background check never falls back to alpha.
 */
import { spawnSync } from './spawn.ts';
import { gitChildEnv } from './git-env.ts';
import { isNewerVersion, isValidVersionString } from './semver.ts';
import type { Action } from './agent-output.ts';
import { MATRIX_REQUIRED_FROM, channelSwitchCommand, type ChannelResolution, type StableLookupError } from './self-upgrade.ts';

const REPO_SLUG = 'garrytan/gbrain';
const GBRAIN_GIT_URL = `https://github.com/${REPO_SLUG}`;
export const STABLE_RECORD_BRANCH = 'stable-record';
export const STABLE_RECORD_FILE = 'stable.json';
export const STABLE_RECORD_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/${STABLE_RECORD_BRANCH}/${STABLE_RECORD_FILE}`;
const RECORD_MAX_BYTES = 64 * 1024;
const STABLE_ERRORS_DOCS = 'docs/guides/upgrades-auto-update.md#stable-channel-errors';
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_URL_RE = /^https:\/\/github\.com\/garrytan\/gbrain\/actions\/runs\/\d+(\/attempts\/\d+)?\/?$/;

export type StableCode = StableLookupError['code'];
export type StableFailure = { ok: false; code: StableCode; cause: string };

export interface StableRecord {
  schema: 1;
  version: string;
  commit: string;
  tree: string;
  soak_run: string;
  matrix_run: string | null;
  promoted_at: string;
  previous: string | null;
  rollback: boolean;
  known_bad: string[];
}

export type GitRunner = (args: string[]) => { status: number | null; stdout: string };
const runGit: GitRunner = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf-8', env: gitChildEnv(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/** `--channel <name>` / `--channel=<name>`: the raw value, '' when the flag has none, null when absent. */
export function parseChannelArg(args: readonly string[]): string | null {
  const at = args.findIndex(a => a === '--channel' || a.startsWith('--channel='));
  if (at === -1) return null;
  if (args[at]!.includes('=')) return args[at]!.slice('--channel='.length);
  const next = args[at + 1];
  return next && !next.startsWith('-') ? next : '';
}

/** Bounded, single-line, credential-free text safe to print and to cache. */
export function sanitizeCause(text: string): string {
  return text
    .replace(/[\s\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(\w+:\/\/)[^\s/@]+@/g, '$1')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '[redacted]')
    .trim()
    .slice(0, 200);
}

/** The evidence keys a record for `version` must carry: soak always; the matrix run from `matrixFrom` on. */
export function requiredEvidenceKeys(version: string, matrixFrom: string | null = MATRIX_REQUIRED_FROM): Array<'soak_run' | 'matrix_run'> {
  return matrixFrom && !isNewerVersion(version, matrixFrom) ? ['soak_run', 'matrix_run'] : ['soak_run'];
}

/** Strict parse of the evidence record; the cause names the first thing wrong. */
export function parseStableRecord(body: string, matrixFrom: string | null = MATRIX_REQUIRED_FROM): { ok: true; record: StableRecord } | { ok: false; cause: string } {
  if (body.length > RECORD_MAX_BYTES) return { ok: false, cause: `the record is larger than ${RECORD_MAX_BYTES} bytes` };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, cause: 'the record is not JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, cause: 'the record is not a JSON object' };
  if (raw.schema !== 1) return { ok: false, cause: `unsupported record schema ${JSON.stringify(raw.schema ?? null)}` };
  const version = raw.version;
  if (typeof version !== 'string' || !isValidVersionString(version)) return { ok: false, cause: 'the record has no valid version' };
  for (const key of ['commit', 'tree'] as const) {
    if (typeof raw[key] !== 'string' || !SHA_RE.test(raw[key] as string)) return { ok: false, cause: `the record has no valid ${key}` };
  }
  for (const key of requiredEvidenceKeys(version, matrixFrom)) {
    if (typeof raw[key] !== 'string' || !RUN_URL_RE.test(raw[key] as string)) {
      return { ok: false, cause: `the record for ${version} lacks the evidence key ${key} (a run of ${REPO_SLUG})` };
    }
  }
  const knownBad = raw.known_bad ?? [];
  if (!Array.isArray(knownBad) || knownBad.some(v => typeof v !== 'string' || !isValidVersionString(v))) {
    return { ok: false, cause: 'known_bad is not a list of versions' };
  }
  if (knownBad.includes(version)) return { ok: false, cause: `the record lists its own version ${version} as known_bad` };
  return {
    ok: true,
    record: {
      schema: 1,
      version,
      commit: raw.commit as string,
      tree: raw.tree as string,
      soak_run: raw.soak_run as string,
      matrix_run: typeof raw.matrix_run === 'string' ? raw.matrix_run : null,
      promoted_at: typeof raw.promoted_at === 'string' ? raw.promoted_at : '',
      previous: typeof raw.previous === 'string' ? raw.previous : null,
      rollback: raw.rollback === true,
      known_bad: knownBad as string[],
    },
  };
}

/** Fetch and validate the evidence record. 5 s timeout; 404 is stable_missing, any other failure to read is unreadable. */
export async function fetchStableRecord(fetchImpl: typeof fetch = fetch, userAgent = 'gbrain'): Promise<{ ok: true; record: StableRecord } | StableFailure> {
  let res: Response;
  try {
    res = await fetchImpl(STABLE_RECORD_URL, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(5_000) });
  } catch (e) {
    return { ok: false, code: 'stable_unreadable', cause: sanitizeCause(`fetching the stable record failed: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (res.status === 404) return { ok: false, code: 'stable_missing', cause: 'no stable record is published (nothing has been promoted to stable)' };
  if (!res.ok) return { ok: false, code: 'stable_unreadable', cause: `the stable record answered HTTP ${res.status}` };
  let body: string;
  try {
    body = await res.text();
  } catch (e) {
    return { ok: false, code: 'stable_unreadable', cause: sanitizeCause(`reading the stable record failed: ${e instanceof Error ? e.message : String(e)}`) };
  }
  const parsed = parseStableRecord(body);
  return parsed.ok ? parsed : { ok: false, code: 'stable_invalid', cause: sanitizeCause(parsed.cause) };
}

/**
 * The release an explicit stable upgrade installs: the record, checked against the repository's tags. The `stable`
 * tag must peel to the record's commit (a mismatch right after a promotion is the raw cache catching up: unreadable,
 * retry) and `v<version>` must be that commit (otherwise the record names no published release: invalid).
 */
export async function resolveStableRelease(deps: { git?: GitRunner; fetch?: typeof fetch } = {}): Promise<{ ok: true; version: string; commit: string; record: StableRecord } | StableFailure> {
  const { status, stdout } = (deps.git ?? runGit)(['ls-remote', '--tags', GBRAIN_GIT_URL]);
  if (status !== 0) return { ok: false, code: 'stable_unreadable', cause: `git ls-remote --tags ${GBRAIN_GIT_URL} failed (offline, or no git)` };
  const refs = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split('\t');
    if (sha && ref) refs.set(ref, sha);
  }
  const peel = (tag: string) => refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  const stableCommit = peel('stable');
  const fetched = await fetchStableRecord(deps.fetch ?? fetch);
  if (!stableCommit) {
    return fetched.ok || fetched.code !== 'stable_unreadable'
      ? { ok: false, code: 'stable_missing', cause: 'the repository has no stable tag (nothing has been promoted to stable)' }
      : fetched;
  }
  if (!fetched.ok) {
    return fetched.code === 'stable_missing'
      ? { ok: false, code: 'stable_invalid', cause: 'the stable tag exists but has no published evidence record' }
      : fetched;
  }
  const { record } = fetched;
  if (stableCommit !== record.commit) {
    return { ok: false, code: 'stable_unreadable', cause: `the stable tag (${stableCommit.slice(0, 12)}) and the evidence record (${record.commit.slice(0, 12)}) disagree; a promotion may still be propagating` };
  }
  if (peel(`v${record.version}`) !== record.commit) {
    return { ok: false, code: 'stable_invalid', cause: `the record names ${record.version}, but v${record.version} is not the stable commit` };
  }
  return { ok: true, version: record.version, commit: record.commit, record };
}

/** What happened, one sentence. */
export function stableFailureMessage(f: { code: StableCode; cause: string }): string {
  const what = f.code === 'stable_missing' ? 'No release has been promoted to the stable channel yet'
    : f.code === 'stable_invalid' ? 'The stable channel has no usable release: its evidence record does not describe a promoted release'
    : 'The stable channel could not be read';
  return `${what}: ${f.cause}.`;
}

/**
 * The next step, rendered against the precedence that chose stable: retry for unreadable; otherwise wait for a
 * promotion or move this install to alpha with the command that overrides what chose stable.
 */
export function stableFailureFix(f: { code: StableCode }, res: ChannelResolution): string {
  if (f.code === 'stable_unreadable') return 'Nothing was changed. Retry in a few minutes: gbrain self-upgrade --check-only';
  return `Nothing was changed. Wait for a stable promotion, or follow every release on alpha: ${channelSwitchCommand('alpha', res)}`;
}

/**
 * The structured next step for a stable failure (agent operator contract): a read-only retry for unreadable; for
 * missing or invalid, switching to alpha is the user's choice (ask_user), with argv only when a config write is what
 * decides the channel (an env or flag override is changed where it is set).
 */
export function stableFailureAction(f: { code: StableCode }, res: ChannelResolution): Action {
  const verify = { argv: ['gbrain', 'self-upgrade', '--check-only', '--json'] };
  if (f.code === 'stable_unreadable') {
    return { argv: verify.argv, consent: [], actor: 'agent', why: 'Read-only: looks up the stable channel again and reports the channel, its source and any error code.', requires_exclusive: false, verify, docs: STABLE_ERRORS_DOCS };
  }
  const userMessage = `Stable has no usable release right now (${f.code}). Wait for a promotion, or follow every release on alpha: ${channelSwitchCommand('alpha', res)}`;
  const common = { ask_user: true as const, consent: [], why: 'Changes which releases this install follows; the user decides.', user_message: userMessage, requires_exclusive: false, verify, docs: STABLE_ERRORS_DOCS };
  return res.source === 'config' || res.source === 'default'
    ? { ...common, argv: ['gbrain', 'config', 'set', 'self_upgrade.channel', 'alpha'], actor: 'agent' }
    : { ...common, actor: 'user' };
}
