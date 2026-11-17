/**
 * GST-2961: a push the Git host refused for the credential git used. "Repository not found" (HTTP 404, what a host
 * says to an account that cannot see a private repository) and HTTP 403 ("Permission to ... denied") come back the
 * same way on every attempt until someone changes which credential git uses, so the publish stops at once with
 * `push_credential_refused` instead of reading it as a transient `push_unconfirmed`.
 *
 * The error names the credential helpers git asked, in the order it asked them, with the scope and file that
 * configure each (system, global, the checkout's own), which one answered and the account login it gave. It learns
 * them by asking git once more (`git credential fill` with GIT_TRACE on stderr), the same lookup the refused push just
 * made; it runs only after a refusal, never on a push that landed. The password is read from that child's stdout and
 * dropped there: it never reaches an error, a log line or the state file, and a helper's command line is shown only up
 * to its program name, because an inline helper (`!f() { echo password=...; }; f`) can carry a secret in its body.
 *
 * The refusal is kept in `brain-push-credential.json` under the git dir until a push lands, so doctor
 * (`git_convergence`) and put_page's `lastPushStatus` report it at once rather than after six hours.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawnSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_ENV } from '../git-transport.ts';
import { git } from './git-run.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type { Action } from '../agent-output.ts';

export type CredentialRefusal = 'not_found' | 'forbidden';

const NOT_FOUND = /^(?:remote: )?(?:ERROR: )?Repository not found\.?\s*$|^fatal: repository '[^']*' not found\s*$|The requested URL returned error: 404\b/m;
const FORBIDDEN = /The requested URL returned error: 403\b|^(?:remote: )?(?:ERROR: )?Permission to \S+ denied to /m;

/** Whether git's stderr for a refused push is the host refusing the credential (404 or 403), as opposed to a fault a retry can clear. */
export function credentialRefusal(stderr: string): CredentialRefusal | null {
  if (NOT_FOUND.test(stderr)) return 'not_found';
  if (FORBIDDEN.test(stderr)) return 'forbidden';
  return null;
}

export interface HelperAsked {
  /** The helper's program as configured, without its arguments (`store`, `/usr/local/bin/helper`, `!gh`). */
  helper: string;
  /** Where git read it: `system`, `global`, `local`, `worktree` or `command`; null when no config entry matched. */
  scope: string | null;
  /** The config file that sets it (`file:<path>`). */
  origin: string | null;
  answered: boolean;
}

export interface PushCredential {
  /** The push URL without any user or password in it. */
  url: string;
  helpers: HelperAsked[];
  /** The account login the answering helper gave, when it gave one. */
  username: string | null;
  note?: string;
}

const anonymize = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');

const TOKEN_PREFIX = /^(?:gh[opusr]_|github_pat_|glpat-|glptt-|gldt-|xox[abpr]-)/i;

/** A login is shown only when it reads as an account name: some helpers store a token as the username, and a long unbroken string can be one. */
const shownLogin = (login: string | null): string | null =>
  login && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(login) && !TOKEN_PREFIX.test(login) && !/^[A-Za-z0-9_-]{30,}$/.test(login) ? login : null;

const SHOWN_COMMAND = /^[A-Za-z0-9._/-]{1,64}$/;

/** A helper's command name only, and only when it has the shape of a plain command or path: arguments can hold a token, and
 *  an inline `!` helper's body or a leading NAME=value assignment can hold one too. Anything else is named generically. */
function programOf(value: string): string {
  const inline = value.startsWith('!');
  const words = (inline ? value.slice(1) : value).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  if (inline) while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  const command = words[i] ?? '';
  if (!SHOWN_COMMAND.test(command)) return inline ? 'an inline shell helper' : 'a credential helper';
  return (inline ? '!' : '') + command + (words.length > i + 1 ? ' …' : '');
}

/** The command line git runs for a configured helper value (credential.c): `!cmd` as is, an absolute path as is, else `git credential-<value>`. */
function commandOf(value: string): string {
  if (value.startsWith('!')) return value.slice(1).trim();
  return isAbsolute(value.split(/\s+/)[0] ?? '') ? value.trim() : 'git credential-' + value.trim();
}

interface ConfiguredHelper { scope: string; origin: string; value: string }

function configuredHelpers(root: string): ConfiguredHelper[] {
  const listed = git(root, ['config', '--show-scope', '--show-origin', '--get-regexp', '^credential\\..*helper$'], { timeoutMs: 10_000, returnStopped: true });
  if (listed.code !== 0) return [];
  return listed.stdout.split('\n').flatMap(line => {
    const [scope, origin, rest] = line.split('\t');
    if (!scope || !origin || rest === undefined) return [];
    const space = rest.indexOf(' ');
    const value = space === -1 ? '' : rest.slice(space + 1);
    return value ? [{ scope, origin, value }] : [];
  });
}

/** The helpers git asks for the push URL of `remote` with the checkout's config, in order, and which one answered; never returns the password. */
export function describePushCredential(root: string, remote: string): PushCredential {
  const raw = git(root, ['remote', 'get-url', '--push', '--', remote], { timeoutMs: 10_000, returnStopped: true }).stdout.split('\n')[0]?.trim() ?? '';
  const url = anonymize(raw);
  if (!/^https?:\/\//i.test(raw)) {
    return { url, helpers: [], username: null,
      note: 'This remote is reached over SSH (or a local path), where git asks no credential helper: the key ssh offers decides the account.' };
  }
  if (/^https?:\/\/[^@/]*:[^@/]*@/i.test(raw)) {
    return { url, helpers: [], username: null, note: 'The remote URL carries its own user and password, so git asked no credential helper: the URL decides the account.' };
  }
  const run = spawnSync('git', ['-C', root, 'credential', 'fill'], {
    input: 'url=' + raw + '\n\n', encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'],
    env: gitChildEnv({ ...GIT_ENV, LC_ALL: 'C', LANGUAGE: 'C', GIT_TRACE: '2', GIT_TRACE_SETUP: '0', GIT_TRACE_PACKET: '0', GIT_TRACE_CURL: '0', GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' }),
  });
  const asked = String(run.stderr ?? '').split('\n').flatMap(line => {
    const m = /trace: run_command: (.*)$/.exec(line);
    if (!m) return [];
    const cmd = m[1]!.replace(/^'(.*)'$/, '$1').replace(/'\\''/g, "'");
    return / get$/.test(cmd) ? [cmd.slice(0, -4)] : [];
  });
  let username: string | null = null;
  let answered = false;
  if (run.status === 0) {
    const fields = String(run.stdout ?? '').split('\n');
    username = fields.find(f => f.startsWith('username='))?.slice('username='.length) || null;
    answered = fields.some(f => f.startsWith('password='));
  }
  const configured = configuredHelpers(root);
  const used = new Set<number>();
  const helpers = asked.map((cmd, i): HelperAsked => {
    const at = configured.findIndex((c, j) => !used.has(j) && commandOf(c.value) === cmd);
    if (at !== -1) used.add(at);
    const entry = at === -1 ? null : configured[at]!;
    return { helper: programOf(entry ? entry.value : cmd), scope: entry?.scope ?? null, origin: entry?.origin ?? null, answered: answered && i === asked.length - 1 };
  });
  const urlUser = /^https?:\/\/[^@/]+@/i.test(raw);
  const askpass = process.env.GIT_ASKPASS ? ' GIT_ASKPASS is set (' + programOf(process.env.GIT_ASKPASS) + '), so git may have used it for the refused push.' : '';
  const note = !helpers.length ? 'Git asked no credential helper for this URL.' + askpass
    : !answered ? 'No credential helper answered when git asked again.' + askpass
    : urlUser ? 'The remote URL names its own user, which is not shown because it can be a token.' : undefined;
  return { url, helpers, username: answered && !urlUser ? shownLogin(username) : null, ...(note ? { note } : {}) };
}

/** One sentence naming the helpers git asked, in order, with scope and file, and which answered for which login. */
export function describeHelpers(cred: Pick<PushCredential, 'helpers' | 'username' | 'note'>): string {
  if (!cred.helpers.length) return cred.note ?? 'Git asked no credential helper.';
  const list = cred.helpers.map((h, i) => (i + 1) + '. ' + h.helper + ' (' + (h.scope ?? 'scope unknown') + (h.origin ? ', ' + h.origin : '') + ')').join('; ');
  const answered = cred.helpers.find(h => h.answered);
  return 'Git asked these credential helpers, in this order: ' + list + '. '
    + (answered ? answered.helper + ' (' + (answered.scope ?? 'scope unknown') + ') answered' + (cred.username ? ' with the account login ' + cred.username : '') + '.' : (cred.note ?? ''));
}

/** Read-only: every credential helper key git consults in `root`, with the scope and file that set it, never the value (an inline helper's body can hold a secret). */
export const credentialHelperKeysArgv = (root: string): string[] =>
  ['git', '-C', root, 'config', '--show-scope', '--show-origin', '--name-only', '--get-regexp', '^credential\\..*helper$'];
export const CREDENTIAL_HELPER_KEYS_WHY = 'Read-only: prints the scope, file and key of every credential helper git consults in this checkout, in the order git reads them, without the value.';

/** The non-retryable error a publish throws when the host refused the push for the credential git used. */
export function pushCredentialRefusedError(root: string, remote: string, branch: string, kind: CredentialRefusal, commit: string): OperationError {
  const cred = describePushCredential(root, remote);
  const answered = cred.helpers.find(h => h.answered);
  const host = kind === 'not_found'
    ? 'answered "Repository not found" (HTTP 404), which is what a Git host tells an account that cannot see a private repository'
    : 'answered HTTP 403 (permission denied)';
  const who = answered
    ? 'the credential from ' + answered.helper + (answered.scope ? ' (' + answered.scope + ' config)' : '') + (cred.username ? ' for ' + cred.username : '')
    : 'the credential git used';
  const helpers = describeHelpers(cred);
  const fix: Action = {
    actor: 'user', consent: [], requires_exclusive: false,
    argv: credentialHelperKeysArgv(root),
    why: CREDENTIAL_HELPER_KEYS_WHY,
    user_message: 'Pushes from ' + root + ' to ' + cred.url + ' are refused: the host ' + (kind === 'not_found' ? 'says the repository is not found' : 'denies permission')
      + ' for ' + who + ', so ' + commit.slice(0, 7) + ' and any earlier local commits stay on this machine (nothing is lost). ' + helpers
      + ' Please make git use a credential for an account that can push to this repository: the read-only command in this fix lists each credential helper key (such as credential.helper) with the file that sets it, so change the key in the file whose helper answered (for example by putting the helper meant for this repository ahead of a machine-wide one), then run gbrain git commit-push --push-only --path ' + root + '.',
    verify: { argv: ['gbrain', 'doctor', '--only', 'git_convergence', '--json'] },
    docs: 'docs/guides/shared-checkout-git.md#push_credential_refused',
  };
  return opError('push_credential_refused',
    remote + ' (' + cred.url + ') refused the push of ' + branch + ': the host ' + host + ', so ' + who + ' cannot push there. ' + helpers + ' The commit is durable locally; gbrain did not retry, because the host refuses the same credential every time.',
    'Ask the user to make git use a credential for an account that can push to this repository, then rerun gbrain git commit-push --push-only. gbrain never changes which credential git uses.',
    { reason: kind, retryable: false, fix,
      detail: JSON.stringify({ commit, remote, branch, kind, url: cred.url, helpers: cred.helpers, username: cred.username, ...(cred.note ? { note: cred.note } : {}) }) });
}

// ── State: one record per checkout until a push lands ───────────────────────

export const CREDENTIAL_STATE_NAME = 'brain-push-credential.json';

export interface CredentialRefusalState {
  branch: string; remote: string; url: string; kind: CredentialRefusal; commit: string;
  helpers: HelperAsked[]; username: string | null; note?: string;
  /** When this refusal was first recorded, the latest refused attempt, and how many attempts were refused since. */
  since: string; at: string; attempts: number;
}

export function readCredentialRefusalFile(statePath: string): CredentialRefusalState | null {
  try { return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) as CredentialRefusalState : null; } catch { return null; }
}

/** Record a push_credential_refused error's detail; a repeat of the same refusal keeps its first time and counts the attempt. */
export function recordCredentialRefusalFile(statePath: string, error: unknown): void {
  try {
    const d = JSON.parse(String((error as { detail?: string }).detail ?? '{}')) as Partial<CredentialRefusalState>;
    const prior = readCredentialRefusalFile(statePath);
    const now = new Date().toISOString();
    const same = !!prior && prior.url === d.url && prior.kind === d.kind;
    const state: CredentialRefusalState = { branch: d.branch ?? '', remote: d.remote ?? '', url: d.url ?? '', kind: d.kind ?? 'forbidden', commit: d.commit ?? '',
      helpers: d.helpers ?? [], username: d.username ?? null, ...(d.note ? { note: d.note } : {}),
      since: same ? prior!.since : now, at: now, attempts: same ? prior!.attempts + 1 : 1 };
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  } catch { /* best-effort */ }
}
