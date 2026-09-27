/**
 * Trust boundary for environment variables that Bun auto-loaded from the
 * CURRENT DIRECTORY's `.env` files.
 *
 * Bun merges `.env`, `.env.local` and the `.env.<NODE_ENV>[.local]` variants
 * from the process cwd into process.env before any user code runs — for
 * `bun run` AND for `bun build --compile` binaries alike (verified on Bun
 * 1.3.10 and 1.3.13). For a globally installed CLI the cwd is arbitrary: any
 * cloned repository can carry a `.env`, so those files are UNTRUSTED input.
 * Bun gives no way to ask which variables came from a file (the merge happens
 * before module load), so this module re-parses the same files and reasons
 * about them. Two guards sit on top of that parse:
 *
 *   - The #427 DATABASE_URL guard (`config.ts:effectiveEnvDatabaseUrl`) is a
 *     VALUE match: the URL is ignored when it equals a cwd-.env assignment.
 *     Running gbrain inside a web-app checkout must not retarget the brain at
 *     that app's database. That value guard never touches
 *     `GBRAIN_DATABASE_URL`; the key-presence quarantine below is what drops
 *     it when a cwd .env ASSIGNS it (a planted brain URL is never intent).
 *   - The security quarantine below is a KEY-PRESENCE match: a protected key
 *     that any cwd .env file assigns is dropped, whatever its value. Value
 *     matching is unsound for a security list because Bun expands `${VAR}`
 *     inside .env values — `KEY=${PWD}/x` lands in process.env as an absolute
 *     path that never equals the file text.
 *
 * What the quarantine covers: the code-loading, exec-target, root-redirect,
 * endpoint-redirect and posture-widening GBRAIN_* keys
 * (`CWD_DOTENV_PROTECTED_KEYS`) AND the loader / git / node / XDG-config /
 * TLS-trust / pager-editor / proxy / AI-endpoint / shell-startup hijack families
 * a cwd .env could plant for the programs gbrain spawns (`CWD_DOTENV_PROTECTED_PREFIXES`,
 * `CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS`) — `isCwdDotenvProtectedKey` is the
 * single predicate. Routing/tuning GBRAIN_* keys and everything not listed
 * still load from a cwd .env. Dropping is in-process; making the drop reach
 * the programs gbrain spawns is `cli-preflight.ts`'s neutral-cwd re-run.
 *
 * Grammar: this parser must accept AT LEAST every line shape Bun's loader
 * accepts, or an assignment Bun honours becomes invisible to the guard. Bun
 * treats `\n`, `\r\n` AND a bare `\r` as line terminators (`A=x\rB=1` sets
 * BOTH keys), keeps U+2028/U+2029 as ordinary value bytes, and does not strip
 * a leading BOM (we strip it anyway — counting one more assignment is the
 * safe side). The right-hand side is therefore matched as "everything up to
 * the line terminator", never as `.*$`: `.` skips `\r` and U+2028/2029, and
 * the `$` anchor then fails, hiding the whole assignment.
 *
 * fs/path only — this runs before anything else in the CLI.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The .env names Bun auto-loads from cwd — a superset across NODE_ENV values
 * so the guards don't depend on replicating Bun's exact selection logic.
 */
export const CWD_DOTENV_FILES: readonly string[] = [
  '.env', '.env.local',
  '.env.development', '.env.development.local',
  '.env.production', '.env.production.local',
  '.env.test', '.env.test.local',
];

// Bun's terminator set: CRLF first so it is consumed as one break.
const LINE_TERMINATOR = /\r\n|\r|\n/;

/**
 * Split .env file content into lines the way Bun's loader does (see the
 * grammar note above) and strip a leading BOM. Shared with the
 * `~/.gbrain/.env` loader in gbrain-env-file.ts so both files speak the same
 * grammar.
 */
export function splitDotenvLines(content: string): string[] {
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return body.split(LINE_TERMINATOR);
}

// `export KEY=...` is accepted so a shell-styled .env still counts as an
// assignment (the guard errs toward "file-origin"). RHS: see the grammar note.
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\r\n]*)$/;

/** One `KEY=<raw rhs>` pair as a cwd .env file spells it (rhs untrimmed, unquoted). */
export type DotenvAssignment = readonly [key: string, raw: string];

/** Every `KEY=<raw rhs>` pair across the cwd .env files in `dir`, in file order. */
function* dotenvAssignments(dir: string): Generator<DotenvAssignment> {
  for (const name of CWD_DOTENV_FILES) {
    let content: string;
    try {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name iterates the fixed CWD_DOTENV_FILES list and dir is the cwd under audit (process.cwd() by default); read-only scan of the .env files Bun auto-loads from there
      content = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue; // missing/unreadable file — nothing to guard against
    }
    for (const rawLine of splitDotenvLines(content)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(ASSIGNMENT);
      if (m) yield [m[1]!, m[2] ?? ''];
    }
  }
}

/**
 * Materialise every assignment across the cwd .env files in `dir` — ONE read
 * of the 8 files that `cwdDotenvAssignsKey` and `quarantineCwdDotenv` both
 * accept in place of `dir`, so cli-preflight.ts parses once per process.
 */
export function parseCwdDotenv(dir: string = process.cwd()): DotenvAssignment[] {
  return [...dotenvAssignments(dir)];
}

/** `dir` (parse now) or an already-parsed list from `parseCwdDotenv`. */
type DirOrAssignments = string | readonly DotenvAssignment[];
function assignmentsOf(source: DirOrAssignments): Iterable<DotenvAssignment> {
  return typeof source === 'string' ? dotenvAssignments(source) : source;
}

/**
 * All values assigned to `key` across the .env files in `dir`. Collecting
 * every assignment (rather than emulating override order) keeps the #427
 * guard independent of dotenv precedence rules — a match against ANY
 * assignment means the value is file-origin. Exported for tests.
 */
export function dotenvValuesForKey(key: string, dir: string = process.cwd()): Set<string> {
  const values = new Set<string>();
  for (const [k, raw] of dotenvAssignments(dir)) {
    if (k !== key) continue;
    let v = raw.trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
        (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf(' #');
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    if (v) values.add(v);
  }
  return values;
}

/**
 * True when ANY cwd .env file in `dir` assigns `key` — the value is ignored
 * (an empty assignment still shadows the key in Bun's loader). This is the
 * predicate the security quarantine and the guardrails loader use. The second
 * argument may be a pre-parsed `parseCwdDotenv(dir)` list.
 */
export function cwdDotenvAssignsKey(key: string, dir: DirOrAssignments = process.cwd()): boolean {
  for (const [k] of assignmentsOf(dir)) {
    if (k === key) return true;
  }
  return false;
}

/**
 * GBRAIN_* variables a cwd `.env` file must never be allowed to set. Each
 * one either makes gbrain load or execute something, relocates its
 * operator-owned roots, or widens a security posture — so a value planted by
 * a cloned repository is never operator intent.
 *
 * Deliberately NOT listed (documented container/service deployments may
 * legitimately co-locate them with the process cwd, and the attack model is
 * a hostile cloned repo, not a serve cwd — SECURITY.md says to launch
 * `serve --http` from a directory you control): GBRAIN_ADMIN_BOOTSTRAP_TOKEN,
 * GBRAIN_HTTP_CORS_ORIGIN, GBRAIN_HTTP_TRUST_PROXY. Deferred for a later
 * decision (TODOS): GBRAIN_SKILLS_DIR, GBRAIN_RECIPES_DIR, GBRAIN_GITHUB_PAT.
 * `test/env-trust-protected-keys.test.ts` fails when a new suspicious-looking
 * read (`_BIN|_CLI|_MODULE|_PATH|_HOME|_URL` suffix, `GBRAIN_ALLOW_` prefix)
 * appears in src/ without a decision here or a `cwd-dotenv-ok:` annotation at
 * the read site.
 */
export const CWD_DOTENV_PROTECTED_KEYS: readonly string[] = [
  // --- code-loading: gbrain import()s the named module -------------------
  'GBRAIN_GUARDRAILS_MODULE',        // guardrail provider module loaded before dispatch
  'GBRAIN_PLUGIN_PATH',              // plugin / skillpack module path
  // --- exec-target: gbrain spawns the named program ------------------------
  'GBRAIN_CLAUDE_CLI_BIN',           // binary run for the claude-cli language model
  'GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG', // becomes that binary's CLAUDE_CONFIG_DIR → its hooks/settings
  'GBRAIN_JOB_CHILD_CLI',            // CLI the job-isolation worker spawns per job
  'GBRAIN_BIN_OVERRIDE',             // gbrain binary used by claw-test
  // --- root / registry redirect ------------------------------------------
  'GBRAIN_HOME',                     // relocates ~/.gbrain (config, .env, keys, registry)
  'GBRAIN_MOUNTS_PATH',              // brain mounts registry file
  'GBRAIN_DATABASE_URL',             // THE brain connection string: a cwd .env would retarget every hook, query and write at a planted database; the #427 value guard covers only the bare DATABASE_URL, and this key is "stated intent" everywhere it is read
  'GBRAIN_DIRECT_DATABASE_URL',      // direct-pool override (connection-manager.ts): retargets brain writes at a planted host; has no #427 value guard
  'GBRAIN_REMOTE_MCP_URL',           // `init --remote` default: where the thin client sends its MCP traffic and bearer token
  'GBRAIN_REMOTE_ISSUER_URL',        // `init --remote` default: the OAuth issuer the client trusts and hands its credential to
  'GBRAIN_OAUTH_RELAY_URL',          // the OAuth relay that hands back Google tokens (creds/relay-client.ts): a planted relay is token theft
  // --- re-run marker ------------------------------------------------------
  'GBRAIN_CWD_ENV_QUARANTINED',      // cli-preflight.ts's sanitized re-run marker; only honoured when the startup cwd IS the .env-free dir it names, so a planted one is inert — listed so it is also dropped and named in the warning
  // --- posture-widening ----------------------------------------------------
  'GBRAIN_ALLOW_SHELL_JOBS',         // enables the shell job handler (arbitrary exec on the worker)
  'GBRAIN_ALLOW_PRIVATE_REMOTES',    // permits git remotes on private networks
  'GBRAIN_ALLOW_UNVERIFIED_REMOTE',  // skips remote verification on workspace push
  'GBRAIN_GIT_ALLOW_FILE_TRANSPORT', // permits the git file:// transport
  'GBRAIN_ALLOW_MASS_RECONCILE',     // lifts the mass-delete reconcile guard
  'GBRAIN_ALLOW_DEFAULT_WRITE',      // permits writes into the 'default' source
  'GBRAIN_NO_SANITY',                // disables content sanity checks
  'GBRAIN_REMOTE_PRIVATE_PAGES',     // exposes private pages to remote callers
];

/**
 * Non-GBRAIN hijack families a cwd `.env` could plant for the PROGRAMS gbrain
 * spawns (git, the claude CLI, bun/node workers, shell jobs). These are
 * normally absent from an operator's environment, which is exactly why a
 * file-planted value lands (Bun never overrides a variable that already
 * exists). Matched by PREFIX because each family is open-ended
 * (`GIT_CONFIG_KEY_<n>`, `LD_*`, `BUN_CONFIG_*`); a family member the shell
 * DID export is untouched unless a cwd .env assigns that same name.
 */
export const CWD_DOTENV_PROTECTED_PREFIXES: readonly string[] = [
  'LD_',         // glibc loader injection (LD_PRELOAD / LD_LIBRARY_PATH / LD_AUDIT) into every dynamically linked child
  'DYLD_',       // the macOS loader's equivalents (DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH)
  'GIT_',        // git config/hook/exec injection: GIT_CONFIG_COUNT/KEY_n/VALUE_n (core.fsmonitor, core.hooksPath), GIT_EXEC_PATH, GIT_SSH*, GIT_ASKPASS
  'BUN_',        // bun runtime hijack for bun-based children: BUN_OPTIONS (--preload), BUN_INSTALL, BUN_CONFIG_*
  'NPM_CONFIG_', // npm registry / script-shell / node-options redirection for npm-based children
  'npm_config_', // the lowercase spelling npm actually reads
  'BASH_FUNC_',  // exported-function injection (`BASH_FUNC_name%%=() {…}`): bash imports the body as a function into every child shell
];

/**
 * Exact non-GBRAIN keys with the same effect as the prefix families above but
 * no shared prefix. Same rule: dropped only when a cwd .env assigns them.
 */
export const CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS: readonly string[] = [
  // --- node preload / resolution / TLS --------------------------------------
  'NODE_OPTIONS',                 // --require/--import a module into every node child (the claude CLI among them)
  'NODE_PATH',                    // extra module-resolution roots → dependency shadowing
  'NODE_EXTRA_CA_CERTS',          // trusts a planted CA → TLS interception of API traffic
  'NODE_TLS_REJECT_UNAUTHORIZED', // =0 disables certificate verification outright
  // --- ssh credential prompts -----------------------------------------------
  'SSH_ASKPASS',                  // program ssh/git run to obtain a passphrase
  'SSH_ASKPASS_REQUIRE',          // forces that program even when a tty is present
  // --- per-user config roots the spawned tools read as GLOBAL config --------
  'XDG_CONFIG_HOME',              // git reads $XDG_CONFIG_HOME/git/config as global config even when ~/.gitconfig exists → core.fsmonitor / core.hooksPath (no GIT_ prefix); the claude CLI and opencode resolve their config dirs from it too
  'XDG_DATA_HOME',                // per-user data root (credential stores, tool state) the children load from
  'XDG_CACHE_HOME',               // per-user cache root — a planted cache is replayed as trusted state
  'GNUPGHOME',                    // gpg home for git commit/tag signing → planted keyring and agent config
  // --- TLS trust roots for the non-node children (git via curl, python, …) --
  'SSL_CERT_FILE', 'SSL_CERT_DIR', // OpenSSL trust store override → a planted CA intercepts every HTTPS call the children make
  'CURL_CA_BUNDLE',               // curl's (and libcurl-linked git's) CA bundle override
  'REQUESTS_CA_BUNDLE',           // python requests' CA bundle override
  // --- OpenSSL code loading: every OpenSSL-linked child (git over https, curl, python, ssh) ---
  'OPENSSL_CONF',                 // a planted openssl.cnf names a provider/engine .so that OpenSSL dlopen()s at init
  'OPENSSL_ENGINES',              // the directory OpenSSL loads engine .so files from
  'OPENSSL_MODULES',              // the directory OpenSSL 3 loads provider .so files from
  // --- per-user roots read raw from the environment by gbrain AND its children ---
  'TMPDIR', 'TMP', 'TEMP',        // os.tmpdir() honours these at call time: a planted (even relative) value steers the sanitized re-run's neutral dir and every temp write into the hostile tree
  'HOME', 'USERPROFILE',          // inert while exported (Bun never overrides a live variable) but under systemd/cron HOME is often UNSET, and the planted value then reaches process.env.HOME and every child's $HOME → ~/.gitconfig, ~/.ssh, ~/.gbrain resolve inside the checkout
  // --- programs the children hand control to -------------------------------
  'EDITOR', 'VISUAL',             // takes.ts spawns $EDITOR || $VISUAL — an arbitrary program
  'PAGER',                        // git (and other children) pipe output through it — an arbitrary program
  // --- interpreter preload for scripted children (git's own helpers included)
  'PYTHONPATH',                   // python module shadowing
  'PYTHONSTARTUP',                // python startup script
  'PERL5LIB',                     // perl library path
  'PERL5OPT',                     // implicit perl -M module load
  'RUBYOPT',                      // implicit ruby -r preload
  'RUBYLIB',                      // ruby library path
  // --- shell startup files / interpreter homes: every NON-INTERACTIVE shell gbrain's children start (the git hooks gbrain writes, `sh -c` in workspace-push and shell jobs) reads these before its first command ---
  'BASH_ENV',                     // bash sources this file at the start of every non-interactive shell — arbitrary code before the script's first line
  // `ENV` (sh/ksh startup file) is deliberately NOT listed: every shell gbrain's children run reads it for INTERACTIVE shells only, and `ENV=production` is a routine key in project .env files.
  'SHELLOPTS',                    // imported read-only into every bash: an inherited `xtrace` turns PS4 into code that runs on every traced command
  'PS4',                          // the xtrace prompt — expanded, `$(…)` command substitution included, before each traced command
  'BASHOPTS',                     // imported shopt set for every bash (expand_aliases, sourcepath, …) — changes how the child parses its own script
  'PROMPT_COMMAND',               // executed before every bash prompt — any interactive child shell (an $EDITOR's shell escape, a hook that drops to a shell) runs it
  'ZDOTDIR',                      // relocates zsh's startup files: .zshenv is sourced by EVERY zsh, scripts included
  'PYTHONHOME',                   // relocates the python stdlib → the interpreter imports planted code on start (PYTHONPATH is listed above)
  'PERLLIB',                      // perl's other library-path variable (PERL5LIB is listed above)
  'GCONV_PATH',                   // glibc loads iconv gconv modules — shared objects — from this directory on any charset conversion, in every glibc-linked child
  // --- proxy MITM of every HTTP client gbrain or its children run -----------
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy',
  // --- AI CLI / API endpoint redirection ------------------------------------
  'CLAUDE_CONFIG_DIR',            // the claude CLI's config dir → its hooks and settings
  'ANTHROPIC_BASE_URL',           // redirects Anthropic API traffic (and the key with it) to a planted host
  'ANTHROPIC_AUTH_TOKEN',         // substitutes the bearer credential the SDK / claude CLI send
  'OPENAI_BASE_URL',              // redirects OpenAI-compatible API traffic
  // --- the same redirection for every other provider gbrain's gateway / probes / recipes read from env (build-gateway-config.ts, probes.ts, recipes/*) — the API key travels to the planted host
  'OPENROUTER_BASE_URL',
  'LITELLM_BASE_URL',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'LLAMA_SERVER_BASE_URL',
  'LLAMA_SERVER_RERANKER_BASE_URL',
];

const PROTECTED_EXACT: ReadonlySet<string> = new Set([
  ...CWD_DOTENV_PROTECTED_KEYS,
  ...CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS,
]);

/** The one predicate: is `key` something a cwd .env must never be allowed to set? */
export function isCwdDotenvProtectedKey(key: string): boolean {
  if (PROTECTED_EXACT.has(key)) return true;
  for (const prefix of CWD_DOTENV_PROTECTED_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export interface QuarantineOpts {
  /** Warning sink; default writes one line to stderr. Injectable for tests. */
  warn?: (line: string) => void;
  /** Pre-parsed `parseCwdDotenv(dir)` list; when given, `dir` is not re-read. */
  assignments?: readonly DotenvAssignment[];
}

/** The remediation every cwd-.env refusal ends with (also used by guardrails.ts). */
export const CWD_DOTENV_REMEDIATION =
  'cwd .env files are untrusted for security settings. Export it from your shell or set it ' +
  'in ~/.gbrain/.env.';

export function formatQuarantineWarning(keys: readonly string[]): string {
  return (
    `[env] Ignoring ${keys.join(', ')} because a .env file in the current directory assigns it — ` +
    CWD_DOTENV_REMEDIATION
  );
}

/**
 * Drop every protected key present in `env` that a cwd .env file in `dir`
 * assigns, and print ONE stderr warning naming them (sorted). Returns the
 * dropped keys, sorted. Iterates the keys the .env files ASSIGN (not a fixed
 * list) so the prefix families are covered.
 *
 * Semantics worth knowing:
 *   - Per-process, in-process. Deleting a key from process.env is NOT seen by
 *     children spawned without an explicit `env` option (Bun hands them the
 *     environ snapshot it took at startup — verified on Bun 1.3.13). So
 *     whenever this returns a non-empty list, `cli-preflight.ts` re-runs
 *     gbrain once from a fresh EMPTY temporary directory with the sanitized
 *     environment: the re-run's Bun never sees the cwd .env, its environ
 *     simply LACKS the dropped keys (deleted, never carried as `''` — git and
 *     the dynamic loader presence-check `GIT_SSL_NO_VERIFY=` /
 *     `LD_TRACE_LOADED_OBJECTS=`), and every descendant inherits that view.
 *     The re-run switches back to the original cwd in its own preflight.
 *   - Key presence, not value. A value the operator exported from the shell
 *     is ALSO dropped while a cwd .env assigns the same key: Bun's `${VAR}`
 *     expansion makes the two indistinguishable, and for this fixed security
 *     list a false drop (loud, with the fix in the message) is the safe side.
 *   - Fail-soft on I/O: an unreadable .env is treated as absent.
 */
export function quarantineCwdDotenv(
  env: Record<string, string | undefined> = process.env,
  dir: string = process.cwd(),
  opts: QuarantineOpts = {},
): string[] {
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const [key] of opts.assignments ?? dotenvAssignments(dir)) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (env[key] === undefined || !isCwdDotenvProtectedKey(key)) continue;
    delete env[key];
    dropped.push(key);
  }
  dropped.sort();
  if (dropped.length > 0) {
    (opts.warn ?? ((line: string) => console.error(line)))(formatQuarantineWarning(dropped));
  }
  return dropped;
}
