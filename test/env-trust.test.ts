/**
 * cwd `.env` quarantine for security-relevant GBRAIN_* variables.
 *
 * Bun auto-loads `.env` from the process cwd (compiled binaries included), so
 * a `.env` committed into a cloned repository lands in process.env before any
 * gbrain code runs. The #427 DATABASE_URL guard matches VALUES, but Bun also
 * expands `${VAR}` inside .env values, so a value-match guard can never
 * recognise `KEY=${PWD}/x` — the quarantine therefore works on KEY PRESENCE:
 * a protected key that any cwd .env file assigns is dropped from the env,
 * whatever its value.
 *
 * The dir is injected instead of process.chdir'd so these tests stay safe in
 * the parallel shard runner (pattern: test/config-env-hijack.test.ts). Scratch
 * dirs are removed in `afterAll` — `process.on('exit')` never fires under
 * `bun test`, which leaked one tmp dir per fixture per run.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  CWD_DOTENV_FILES,
  CWD_DOTENV_PROTECTED_KEYS,
  CWD_DOTENV_PROTECTED_PREFIXES,
  CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS,
  CWD_DOTENV_REMEDIATION,
  cwdDotenvAssignsKey,
  dotenvValuesForKey,
  isCwdDotenvProtectedKey,
  parseCwdDotenv,
  quarantineCwdDotenv,
} from '../src/core/env-trust.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
function tmpProject(envFiles: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-env-trust-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(envFiles)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('cwdDotenvAssignsKey', () => {
  test('true when any auto-loaded .env variant assigns the key, regardless of value', () => {
    const dir = tmpProject({
      '.env': 'UNRELATED=1\n',
      '.env.production.local': 'GBRAIN_GUARDRAILS_MODULE=${PWD}/tooling/probe.ts\n',
    });
    expect(cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', dir)).toBe(true);
    expect(cwdDotenvAssignsKey('UNRELATED', dir)).toBe(true);
    expect(cwdDotenvAssignsKey('GBRAIN_HOME', dir)).toBe(false);
  });

  test('accepts export prefix, quoting, and an EMPTY value (presence, not value)', () => {
    const dir = tmpProject({
      '.env': ['# comment', 'export GBRAIN_ALLOW_SHELL_JOBS="1"', 'GBRAIN_HOME=', ''].join('\n'),
    });
    expect(cwdDotenvAssignsKey('GBRAIN_ALLOW_SHELL_JOBS', dir)).toBe(true);
    // An empty assignment still shadows the key in Bun's loader.
    expect(cwdDotenvAssignsKey('GBRAIN_HOME', dir)).toBe(true);
    // A commented-out assignment is not an assignment.
    expect(cwdDotenvAssignsKey('comment', dir)).toBe(false);
  });

  test('false when no .env file exists, or the name is outside the auto-load set', () => {
    const none = tmpProject({});
    expect(cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', none)).toBe(false);
    const staging = tmpProject({ '.env.staging': 'GBRAIN_GUARDRAILS_MODULE=/x\n' });
    expect(cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', staging)).toBe(false);
    expect(CWD_DOTENV_FILES).toContain('.env');
    expect(CWD_DOTENV_FILES).not.toContain('.env.staging');
  });

  test('dotenvValuesForKey (moved from config.ts) still collects values', () => {
    const dir = tmpProject({ '.env': 'DATABASE_URL=postgres://app.example.test/db\n' });
    expect(dotenvValuesForKey('DATABASE_URL', dir).has('postgres://app.example.test/db')).toBe(true);
  });
});

describe('CWD_DOTENV_PROTECTED_KEYS', () => {
  test('covers the code-loading, exec-target, redirect and posture-widening keys', () => {
    for (const k of [
      'GBRAIN_GUARDRAILS_MODULE', 'GBRAIN_PLUGIN_PATH',
      'GBRAIN_CLAUDE_CLI_BIN', 'GBRAIN_CLAUDE_CLI_HERMETIC_CONFIG', 'GBRAIN_JOB_CHILD_CLI', 'GBRAIN_BIN_OVERRIDE',
      'GBRAIN_HOME', 'GBRAIN_MOUNTS_PATH',
      'GBRAIN_ALLOW_SHELL_JOBS', 'GBRAIN_ALLOW_PRIVATE_REMOTES', 'GBRAIN_ALLOW_UNVERIFIED_REMOTE',
      'GBRAIN_GIT_ALLOW_FILE_TRANSPORT', 'GBRAIN_ALLOW_MASS_RECONCILE', 'GBRAIN_ALLOW_DEFAULT_WRITE',
      'GBRAIN_NO_SANITY', 'GBRAIN_REMOTE_PRIVATE_PAGES',
    ]) {
      expect(CWD_DOTENV_PROTECTED_KEYS).toContain(k);
    }
    // Deliberately NOT protected (documented service deployments co-locate them).
    for (const k of ['GBRAIN_ADMIN_BOOTSTRAP_TOKEN', 'GBRAIN_HTTP_CORS_ORIGIN', 'GBRAIN_HTTP_TRUST_PROXY']) {
      expect(CWD_DOTENV_PROTECTED_KEYS).not.toContain(k);
    }
  });

  // Review cycle 3: a cwd .env that assigns GBRAIN_DATABASE_URL retargets every
  // hook, query and write at a planted database (the sibling
  // GBRAIN_DIRECT_DATABASE_URL was already protected for the same reason), and a
  // planted OAuth relay is handed the operator's tokens. The #427 VALUE guard in
  // config.ts is untouched — it still never auto-ignores GBRAIN_DATABASE_URL —
  // the KEY-PRESENCE quarantine is what drops a cwd-.env-assigned one.
  test('GBRAIN_DATABASE_URL and GBRAIN_OAUTH_RELAY_URL are protected (review cycle 3)', () => {
    for (const k of ['GBRAIN_DATABASE_URL', 'GBRAIN_OAUTH_RELAY_URL']) {
      expect(CWD_DOTENV_PROTECTED_KEYS).toContain(k);
      expect(isCwdDotenvProtectedKey(k)).toBe(true);
    }
    const dir = tmpProject({ '.env': 'GBRAIN_DATABASE_URL=postgres://planted.example.test/brain\n' });
    const env: Record<string, string | undefined> = { GBRAIN_DATABASE_URL: 'postgres://planted.example.test/brain' };
    const warnings: string[] = [];
    expect(quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) })).toEqual(['GBRAIN_DATABASE_URL']);
    expect('GBRAIN_DATABASE_URL' in env).toBe(false);
    expect(warnings[0]).toContain('Ignoring GBRAIN_DATABASE_URL because a .env file in the current directory assigns it');
  });

  test('endpoint-redirect GBRAIN_* keys and the sanitized re-run marker are protected (review cycle 2)', () => {
    for (const k of ['GBRAIN_DIRECT_DATABASE_URL', 'GBRAIN_REMOTE_MCP_URL', 'GBRAIN_REMOTE_ISSUER_URL', 'GBRAIN_CWD_ENV_QUARANTINED']) {
      expect(CWD_DOTENV_PROTECTED_KEYS).toContain(k);
      expect(isCwdDotenvProtectedKey(k)).toBe(true);
    }
  });
});

// ── Parse once (A2-7): the pre-parsed list is interchangeable with `dir` ─────
describe('parseCwdDotenv — one read shared by both consumers', () => {
  test('cwdDotenvAssignsKey and quarantineCwdDotenv give identical answers for `dir` and for parseCwdDotenv(dir)', () => {
    const dir = tmpProject({
      '.env': 'GIT_CONFIG_COUNT=1\nGBRAIN_HOME=${PWD}/h\nPROJECT_NAME=demo\n',
      '.env.local': 'export XDG_CONFIG_HOME="/x"\n',
    });
    const assignments = parseCwdDotenv(dir);
    expect(assignments).toEqual([
      ['GIT_CONFIG_COUNT', '1'], ['GBRAIN_HOME', '${PWD}/h'], ['PROJECT_NAME', 'demo'], ['XDG_CONFIG_HOME', '"/x"'],
    ]);
    for (const k of ['GIT_CONFIG_COUNT', 'GBRAIN_HOME', 'PROJECT_NAME', 'XDG_CONFIG_HOME', 'ABSENT']) {
      expect(cwdDotenvAssignsKey(k, assignments)).toBe(cwdDotenvAssignsKey(k, dir));
    }
    const mk = () => ({ GIT_CONFIG_COUNT: '1', GBRAIN_HOME: `${dir}/h`, PROJECT_NAME: 'demo', XDG_CONFIG_HOME: '/x', GIT_AUTHOR_NAME: 'shell' });
    const viaDir = mk(); const viaList = mk();
    const w1: string[] = []; const w2: string[] = [];
    const d1 = quarantineCwdDotenv(viaDir, dir, { warn: (m) => w1.push(m) });
    const d2 = quarantineCwdDotenv(viaList, '/nonexistent/never-read', { warn: (m) => w2.push(m), assignments });
    expect(d2).toEqual(d1);
    expect(d2).toEqual(['GBRAIN_HOME', 'GIT_CONFIG_COUNT', 'XDG_CONFIG_HOME']);
    expect(viaList).toEqual(viaDir);
    expect(w2).toEqual(w1);
  });

  test('parseCwdDotenv of a dir without .env files is empty', () => {
    expect(parseCwdDotenv(tmpProject({}))).toEqual([]);
  });
});

describe('quarantineCwdDotenv', () => {
  test('drops a protected key the cwd .env assigns — including the ${PWD}-expanded case', () => {
    const dir = tmpProject({ '.env': 'GBRAIN_GUARDRAILS_MODULE=${PWD}/tooling/probe.ts\n' });
    // What Bun actually puts in process.env after expansion: an ABSOLUTE path
    // that no value-match against the literal file text could recognise.
    const env: Record<string, string | undefined> = {
      GBRAIN_GUARDRAILS_MODULE: `${dir}/tooling/probe.ts`,
      GBRAIN_UNRELATED_THING: 'kept',
      PATH: '/usr/bin',
    };
    const warnings: string[] = [];
    const dropped = quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) });
    expect(dropped).toEqual(['GBRAIN_GUARDRAILS_MODULE']);
    expect('GBRAIN_GUARDRAILS_MODULE' in env).toBe(false);
    expect(env.GBRAIN_UNRELATED_THING).toBe('kept');
    expect(env.PATH).toBe('/usr/bin');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      '[env] Ignoring GBRAIN_GUARDRAILS_MODULE because a .env file in the current directory ' +
      'assigns it — cwd .env files are untrusted for security settings. Export it from your ' +
      'shell or set it in ~/.gbrain/.env.',
    );
  });

  test('several protected keys → ONE warning naming all of them; unprotected assigned keys untouched', () => {
    const dir = tmpProject({
      '.env': 'GBRAIN_ALLOW_SHELL_JOBS=1\nGBRAIN_SOURCE=wiki\n',
      '.env.local': 'GBRAIN_HOME=/tmp/elsewhere\n',
    });
    const env: Record<string, string | undefined> = {
      GBRAIN_ALLOW_SHELL_JOBS: '1',
      GBRAIN_HOME: '/tmp/elsewhere',
      GBRAIN_SOURCE: 'wiki',
    };
    const warnings: string[] = [];
    const dropped = quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) });
    expect(dropped.sort()).toEqual(['GBRAIN_ALLOW_SHELL_JOBS', 'GBRAIN_HOME']);
    expect(env.GBRAIN_ALLOW_SHELL_JOBS).toBeUndefined();
    expect(env.GBRAIN_HOME).toBeUndefined();
    expect(env.GBRAIN_SOURCE).toBe('wiki'); // not a protected key
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('GBRAIN_ALLOW_SHELL_JOBS');
    expect(warnings[0]).toContain('GBRAIN_HOME');
  });

  test('a protected key that is set in env but NOT assigned by any cwd .env is honored', () => {
    const dir = tmpProject({ '.env': 'SOMETHING_ELSE=1\n' });
    const env: Record<string, string | undefined> = { GBRAIN_ALLOW_SHELL_JOBS: '1' };
    const warnings: string[] = [];
    expect(quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) })).toEqual([]);
    expect(env.GBRAIN_ALLOW_SHELL_JOBS).toBe('1');
    expect(warnings).toHaveLength(0);
  });

  test('no .env files → no-op, no warning; assigned-but-unset key → nothing to drop', () => {
    const none = tmpProject({});
    const env: Record<string, string | undefined> = { GBRAIN_HOME: '/tmp/x' };
    const warnings: string[] = [];
    expect(quarantineCwdDotenv(env, none, { warn: (m) => warnings.push(m) })).toEqual([]);
    expect(env.GBRAIN_HOME).toBe('/tmp/x');
    // Assigned in .env but absent from env (e.g. a `--no-env-file` run): nothing to report.
    const dir = tmpProject({ '.env': 'GBRAIN_HOME=/tmp/y\n' });
    expect(quarantineCwdDotenv({}, dir, { warn: (m) => warnings.push(m) })).toEqual([]);
    expect(warnings).toHaveLength(0);
  });

  test('quarantining process.env is visible to a child spawned with env: process.env', async () => {
    const dir = tmpProject({ '.env': 'GBRAIN_ALLOW_SHELL_JOBS=1\n' });
    await withEnv({ GBRAIN_ALLOW_SHELL_JOBS: '1' }, async () => {
      const dropped = quarantineCwdDotenv(process.env, dir, { warn: () => {} });
      expect(dropped).toEqual(['GBRAIN_ALLOW_SHELL_JOBS']);
      expect(process.env.GBRAIN_ALLOW_SHELL_JOBS).toBeUndefined();
      const proc = Bun.spawn(
        [process.execPath, '--no-env-file', '-e', 'process.stdout.write(String(process.env.GBRAIN_ALLOW_SHELL_JOBS ?? "<unset>"))'],
        { cwd: tmpProject({}), env: process.env as Record<string, string>, stdout: 'pipe', stderr: 'pipe' },
      );
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(out).toBe('<unset>');
    });
  });
});

// ── A1: line terminators / encoding must match Bun's loader ──────────────────
//
// Bun treats a bare `\r` as a .env line terminator (verified on 1.3.13:
// `KEY=/e\rvil` loads as `/e`, and `A=x\rB=1` loads BOTH keys). A parser that
// split on `\n` only saw one over-long line whose RHS the `(.*)$` anchor could
// not match (`.` skips `\r` and U+2028/2029), so the assignment vanished and
// the quarantine let the key through. Every case below must count as
// "assigned" — erring toward file-origin is the safe side of this guard.
describe('dotenv grammar: CR / CRLF / BOM / U+2028 (A1)', () => {
  const cases: Array<[label: string, body: string]> = [
    ['CR-only file', 'UNRELATED=1\rGBRAIN_GUARDRAILS_MODULE=${PWD}/evil.js\r'],
    ['mid-line bare CR hiding a second assignment', 'UNRELATED=${PWD}/x\rGBRAIN_GUARDRAILS_MODULE=${PWD}/evil.js\nX=1\n'],
    ['CRLF file', 'UNRELATED=1\r\nGBRAIN_GUARDRAILS_MODULE=${PWD}/evil.js\r\n'],
    ['BOM-prefixed first line', '﻿GBRAIN_GUARDRAILS_MODULE=${PWD}/evil.js\n'],
    ['U+2028 inside a value', 'GBRAIN_GUARDRAILS_MODULE=${PWD}/ev il.js\n'],
  ];
  for (const [label, body] of cases) {
    test(`${label}: the key counts as assigned and is quarantined`, () => {
      const dir = tmpProject({ '.env': body });
      expect(cwdDotenvAssignsKey('GBRAIN_GUARDRAILS_MODULE', dir)).toBe(true);
      const env: Record<string, string | undefined> = { GBRAIN_GUARDRAILS_MODULE: `${dir}/evil.js` };
      const warnings: string[] = [];
      expect(quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) })).toEqual(['GBRAIN_GUARDRAILS_MODULE']);
      expect('GBRAIN_GUARDRAILS_MODULE' in env).toBe(false);
      expect(warnings).toHaveLength(1);
    });
  }

  test('a bare CR terminates the value for the #427 guard too, and the hidden key is an assignment', () => {
    const dir = tmpProject({ '.env': 'DATABASE_URL=postgres://app.example.test/db\rOTHER=1\n' });
    expect(dotenvValuesForKey('DATABASE_URL', dir).has('postgres://app.example.test/db')).toBe(true);
    expect(cwdDotenvAssignsKey('OTHER', dir)).toBe(true);
  });
});

// ── A2: loader / git / node / proxy / AI-CLI hijack families ─────────────────
describe('non-GBRAIN hijack families (A2)', () => {
  test('isCwdDotenvProtectedKey: exact GBRAIN_* keys, prefix families, exact toolchain keys', () => {
    for (const k of [
      'GBRAIN_HOME', 'GBRAIN_GUARDRAILS_MODULE',
      'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
      'BUN_OPTIONS', 'BUN_INSTALL', 'NPM_CONFIG_REGISTRY', 'npm_config_registry',
      'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
      'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5LIB', 'PERL5OPT', 'RUBYOPT', 'RUBYLIB',
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
      'CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL',
    ]) {
      expect(isCwdDotenvProtectedKey(k)).toBe(true);
    }
    // Ordinary project variables keep loading from a cwd .env.
    for (const k of ['GITHUB_TOKEN', 'GBRAIN_SOURCE', 'DATABASE_URL', 'PATH', 'LDFLAGS', 'NODE_ENV', 'OPENAI_API_KEY', 'GITLAB_CI', 'BUNDLE_PATH', 'TMPFILE', 'HOMEBREW_PREFIX']) {
      expect(isCwdDotenvProtectedKey(k)).toBe(false);
    }
    // Review cycle 2 (red team): XDG config roots git reads as GLOBAL config, TLS trust roots,
    // the programs children hand control to, and every provider endpoint the gateway reads from env.
    for (const k of [
      'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'GNUPGHOME',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
      'EDITOR', 'VISUAL', 'PAGER',
      'OPENROUTER_BASE_URL', 'LITELLM_BASE_URL', 'OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL',
      'LLAMA_SERVER_BASE_URL', 'LLAMA_SERVER_RERANKER_BASE_URL',
    ]) {
      expect(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS).toContain(k);
      expect(isCwdDotenvProtectedKey(k)).toBe(true);
    }
    // Review cycle 3: OpenSSL code loading for every OpenSSL-linked child, the temp
    // root the sanitized re-run's neutral dir is created under, and HOME (inert while
    // exported, live when a cron/systemd unit leaves it unset).
    for (const k of ['OPENSSL_CONF', 'OPENSSL_ENGINES', 'OPENSSL_MODULES', 'TMPDIR', 'TMP', 'TEMP', 'HOME', 'USERPROFILE']) {
      expect(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS).toContain(k);
      expect(isCwdDotenvProtectedKey(k)).toBe(true);
    }
    for (const p of ['LD_', 'DYLD_', 'GIT_', 'BUN_', 'NPM_CONFIG_', 'npm_config_']) expect(CWD_DOTENV_PROTECTED_PREFIXES).toContain(p);
    expect(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS).toContain('NODE_OPTIONS');
    expect(new Set(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS).size).toBe(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS.length);
  });

  test('a GIT_CONFIG_* injection planted by the cwd .env is dropped (prefix family), ONE warning naming the keys', () => {
    const dir = tmpProject({
      '.env': 'GIT_CONFIG_COUNT=1\nGIT_CONFIG_KEY_0=core.fsmonitor\nGIT_CONFIG_VALUE_0=./tooling/evil.sh\nGBRAIN_ALLOW_SHELL_JOBS=1\nGIT_UNSET_IN_ENV=1\nPROJECT_NAME=demo\n',
    });
    const env: Record<string, string | undefined> = {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: `${dir}/tooling/evil.sh`,
      GBRAIN_ALLOW_SHELL_JOBS: '1', PROJECT_NAME: 'demo', GIT_AUTHOR_NAME: 'from-the-shell', PATH: '/usr/bin',
    };
    const warnings: string[] = [];
    const dropped = quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) });
    expect(dropped).toEqual(['GBRAIN_ALLOW_SHELL_JOBS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
    for (const k of dropped) expect(k in env).toBe(false);
    expect(env.PROJECT_NAME).toBe('demo');          // not protected
    expect(env.GIT_AUTHOR_NAME).toBe('from-the-shell'); // protected family, but NOT assigned by the cwd .env
    expect(env.PATH).toBe('/usr/bin');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[env\] Ignoring GBRAIN_ALLOW_SHELL_JOBS, GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0 because a \.env file in the current directory assigns it — /);
    expect(warnings[0]).toContain(CWD_DOTENV_REMEDIATION);
  });
});

// ── Review cycle 4 (E4-1): shell-startup files + interpreter homes ───────────
//
// Every non-interactive shell gbrain's children start (git hooks gbrain writes,
// `sh -c` in workspace-push and shell jobs) sources $BASH_ENV first; an
// imported SHELLOPTS=xtrace with a `$(…)` PS4 runs on every traced command;
// PYTHONHOME / PERLLIB / GCONV_PATH relocate code the interpreters and glibc
// load. None of these carry a listed prefix, so each is an exact key here;
// BASH_FUNC_ (exported-function injection) is a prefix family.
describe('shell-startup / interpreter-home family (review cycle 4)', () => {
  const SHELL_STARTUP_KEYS = [
    'BASH_ENV', 'SHELLOPTS', 'PS4', 'BASHOPTS', 'PROMPT_COMMAND', 'ZDOTDIR',
    'PYTHONHOME', 'PERLLIB', 'GCONV_PATH',
  ];

  test('each shell-startup / interpreter-home key is an exact protected toolchain key', () => {
    for (const k of SHELL_STARTUP_KEYS) {
      expect(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS).toContain(k);
      expect(isCwdDotenvProtectedKey(k)).toBe(true);
    }
    expect(new Set(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS).size).toBe(CWD_DOTENV_PROTECTED_TOOLCHAIN_KEYS.length);
  });

  test('BASH_FUNC_ is a protected prefix (exported-function injection), by prefix not by exact name', () => {
    expect(CWD_DOTENV_PROTECTED_PREFIXES).toContain('BASH_FUNC_');
    for (const k of ['BASH_FUNC_git%%', 'BASH_FUNC_ls()', 'BASH_FUNC_x']) expect(isCwdDotenvProtectedKey(k)).toBe(true);
    // Neighbours that must keep loading from a cwd .env.
    for (const k of ['BASH_VERSION', 'BASH', 'ENVIRONMENT', 'PS1', 'SHELL', 'PYTHONDONTWRITEBYTECODE', 'PERL_BADLANG']) {
      expect(isCwdDotenvProtectedKey(k)).toBe(false);
    }
  });

  test('a planted BASH_ENV (the ${PWD}-expanded shape) is dropped from the env and named in the ONE warning', () => {
    const dir = tmpProject({ '.env': 'BASH_ENV=${PWD}/tooling/rc.sh\nSHELLOPTS=xtrace\nPS4=$(touch /tmp/x)\nPROJECT_NAME=demo\n' });
    const env: Record<string, string | undefined> = {
      BASH_ENV: `${dir}/tooling/rc.sh`, SHELLOPTS: 'xtrace', PS4: '$(touch /tmp/x)', PROJECT_NAME: 'demo', PATH: '/usr/bin',
    };
    const warnings: string[] = [];
    expect(quarantineCwdDotenv(env, dir, { warn: (m) => warnings.push(m) })).toEqual(['BASH_ENV', 'PS4', 'SHELLOPTS']);
    for (const k of ['BASH_ENV', 'PS4', 'SHELLOPTS']) expect(k in env).toBe(false);
    expect(env.PROJECT_NAME).toBe('demo');
    expect(env.PATH).toBe('/usr/bin');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Ignoring BASH_ENV, PS4, SHELLOPTS because a .env file in the current directory assigns it');
  });
});
