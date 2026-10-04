/**
 * Shared fixture + normalizer for the W0 `gbrain doctor --json` goldens
 * (test/doctor-json-golden.test.ts on PGLite, test/e2e/doctor-json-golden.test.ts
 * on Postgres).
 *
 * Hermetic child: a fresh temp home (HOME = GBRAIN_HOME), cwd outside the
 * repo (so working-tree state such as eval_drift never leaks in), audit and
 * sync-failure ledgers under the home, a two-line fixture skills dir passed
 * with `--skills-dir`, PATH reduced to a private bun symlink plus /usr/bin:/bin
 * (a globally linked `gbrain` would otherwise make npm_squat fire), every provider key removed, startup hooks skipped, and
 * `fetch` refused by test/helpers/no-network-preload.ts (attempted URLs are
 * returned so the test can assert none happened).
 *
 * Normalizer `doctor-json-v1`: ordered checks (name, status, message,
 * details, issues) plus the report envelope, with volatile tokens replaced:
 * temp home / repo / os tmpdir paths, UUIDs, ISO timestamps, the running
 * package and Bun versions, the machine hostname, and `*_ms` / elapsed / pid-style
 * detail keys. Check order is emitted order (deterministic; no Map/Set
 * iteration is re-sorted). stderr lines are kept (normalized) because the
 * early-stop paths announce themselves there.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { defineNormalizer, mapStrings, scrubKeys, scrubPaths, scrubTimestamps } from './golden.ts';
import { PROVIDER_ENV_KEYS } from './provider-env.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const PRELOAD = join(import.meta.dir, 'no-network-preload.ts');
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;

export interface DoctorHome {
  home: string;
  work: string;
  skillsDir: string;
  netLog: string;
  cleanup: () => void;
}

export function makeDoctorHome(prefix: string): DoctorHome {
  const home = mkdtempSync(join(tmpdir(), `gbrain-${prefix}-`));
  const work = join(home, 'work');
  const skillsDir = join(home, 'skills');
  mkdirSync(work, { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(home, 'bin', 'bun'));
  mkdirSync(join(skillsDir, 'alpha-example'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'alpha-example', 'SKILL.md'),
    '---\nname: alpha-example\ntriggers:\n  - "alpha example trigger"\n---\n# alpha-example\n\nA fixture skill.\n',
  );
  writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify({ skills: [{ name: 'alpha-example', path: 'alpha-example/SKILL.md' }] }));
  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    '# RESOLVER\n\n## Brain operations\n| Trigger | Skill |\n|---------|-------|\n| "alpha example trigger" | `skills/alpha-example/SKILL.md` |\n',
  );
  return {
    home,
    work,
    skillsDir,
    netLog: join(home, 'net.log'),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

export interface GbrainRun {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout when it is one JSON document, else null. */
  json: unknown;
  /** Replacement roots for the normalizer. */
  roots: Record<string, string>;
}

/** Spawn `bun src/cli.ts <args>` in the hermetic doctor env. */
export async function runGbrain(h: DoctorHome, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 120_000): Promise<GbrainRun> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  for (const k of PROVIDER_ENV_KEYS) delete childEnv[k];
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_PGLITE_SNAPSHOT', 'GBRAIN_SKILLS_DIR', 'OPENCLAW_WORKSPACE']) delete childEnv[k];
  // harness_wiring reads agent markers and harness config homes: keep the golden independent of the host's harness.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'CODEX_HOME', 'OPENCODE', 'OPENCODE_PID', 'XDG_CONFIG_HOME']) delete childEnv[k];
  Object.assign(childEnv, {
    HOME: h.home,
    GBRAIN_HOME: h.home,
    GBRAIN_AUDIT_DIR: join(h.home, 'audit'),
    GBRAIN_SYNC_FAILURES_DIR: join(h.home, 'sync-failures'),
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_TEST_NET_LOG: h.netLog,
    NO_COLOR: '1',
    PATH: [join(h.home, 'bin'), '/usr/bin', '/bin'].join(delimiter),
  });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const proc = Bun.spawn([process.execPath, '--no-env-file', '--preload', PRELOAD, CLI, ...args], {
    cwd: h.work,
    env: childEnv,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => proc.kill(9), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    let json: unknown = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    return { args, exitCode: exitCode ?? -1, stdout, stderr, json, roots: { '<home>': h.home, '<repo>': REPO_ROOT } };
  } finally {
    clearTimeout(killer);
  }
}

export function networkAttempts(h: DoctorHome): string[] {
  return existsSync(h.netLog) ? readFileSync(h.netLog, 'utf-8').split('\n').filter(Boolean) : [];
}

/** Rewrite the fresh config.json (the only way `gbrain init` leaves it) with `patch`. */
export function patchConfig(h: DoctorHome, patch: (cfg: Record<string, unknown>) => void): void {
  const file = join(h.home, '.gbrain', 'config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
  patch(cfg);
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const VOLATILE_KEYS = /(^|_)(ms|pid|elapsed|duration|uptime)$|_ms$|^elapsed/i;

export function normalizeDoctorText(text: string, roots: Record<string, string>, extra: Array<[RegExp | string, string]> = []): string {
  let out = scrubPaths(text, roots);
  for (const [pattern, label] of extra) out = typeof pattern === 'string' ? out.split(pattern).join(label) : out.replace(pattern, label);
  out = scrubTimestamps(out).replace(UUID, '<uuid>');
  out = out.replace(/\(most recent caller: at [^()]*\([^()]*\)\)/g, '(most recent caller: <frame>)');
  out = out.split(PACKAGE_VERSION).join('<version>');
  out = out.split(`Bun ${Bun.version}`).join('Bun <bun-version>');
  const host = hostname();
  if (host) out = out.split(host).join('<hostname>');
  return out;
}

/** `doctor-json-v1` with optional extra literal/regex replacements (e.g. a Postgres URL). */
export function doctorJsonNormalizer(extra: Array<[RegExp | string, string]> = [], name = 'doctor-json-v1') {
  return defineNormalizer<GbrainRun>(name, (run) => {
    const fn = (s: string) => normalizeDoctorText(s, run.roots, extra);
    return {
      args: run.args.map(fn),
      exit_code: run.exitCode,
      report: run.json === null ? null : mapStrings(scrubKeys(run.json, VOLATILE_KEYS), fn),
      stdout: run.json === null ? fn(run.stdout).split('\n').filter(Boolean) : '<json>',
      stderr: fn(run.stderr).split('\n').filter(Boolean),
    };
  });
}
