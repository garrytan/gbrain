/** Machine facts, process memory, disk size and the Postgres server process tree. */
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, totalmem } from 'node:os';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export function machineInfo() {
  const c = cpus();
  return {
    os: `${platform()} ${release()}`,
    cpu: c[0]?.model?.trim() ?? 'unknown',
    cores: c.length,
    mem_gb: Math.round(totalmem() / 2 ** 30),
  };
}

export function gitInfo(): { git_sha: string; git_dirty: boolean } {
  try {
    const sha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0;
    return { git_sha: sha, git_dirty: dirty };
  } catch {
    return { git_sha: 'unknown', git_dirty: false };
  }
}

/**
 * Provider credentials never reach the benchmark or its children: nothing here calls an embedding or chat model
 * (vectors come from the corpus), and a stray key must not be able to start a provider call by accident.
 */
const SECRET_NAME = /(API_KEY|_TOKEN|SECRET|PASSWORD|ANTHROPIC|OPENAI|VOYAGE|GOOGLE_|GEMINI|COHERE|MISTRAL|GROQ|TOGETHER|OPENROUTER|DEEPSEEK|XAI_|AZURE_)/i;

export function stripSecretsFromEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_NAME.test(k)) out[k] = v;
  return out;
}

export function scrubProcessEnv(): number {
  let removed = 0;
  for (const k of Object.keys(process.env)) if (SECRET_NAME.test(k)) { delete process.env[k]; removed++; }
  return removed;
}

/** Peak resident set of this process, bytes (Linux VmHWM; falls back to getrusage). */
export function selfPeakRssBytes(): number {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch { /* not Linux */ }
  return process.resourceUsage().maxRSS * 1024;
}

export interface ServerMemory { processes: number; rss_bytes: number; pss_bytes: number | null; hwm_bytes: number }

function procStatusKb(pid: number, field: string): number {
  try {
    // A line parse, not a RegExp built from `field`: /proc/<pid>/status lines read "VmRSS:\t  1234 kB".
    const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith(`${field}:`));
    const value = line ? Number.parseInt(line.slice(field.length + 1).trim(), 10) : Number.NaN;
    return Number.isFinite(value) ? value : 0;
  } catch { return 0; }
}

function descendants(rootPid: number): number[] {
  const parentOf = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parentOf.set(Number(name), Number(after[1]));
    } catch { /* process exited */ }
  }
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) for (const [pid, ppid] of parentOf) if (ppid === out[i] && !out.includes(pid)) out.push(pid);
  return out;
}

/** Summed memory of the Postgres postmaster and every process under it. `pgDataDir/postmaster.pid` names the postmaster. */
export function postgresServerMemory(pgDataDir: string): ServerMemory | null {
  try {
    const pidFile = join(pgDataDir, 'postmaster.pid');
    if (!existsSync(pidFile)) return null;
    const postmaster = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
    if (!Number.isInteger(postmaster) || postmaster <= 0) return null;
    const pids = descendants(postmaster);
    let rss = 0, hwm = 0, pss = 0, pssOk = true;
    for (const pid of pids) {
      rss += procStatusKb(pid, 'VmRSS') * 1024;
      hwm += procStatusKb(pid, 'VmHWM') * 1024;
      try {
        const m = /Pss:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
        if (m) pss += Number(m[1]) * 1024; else pssOk = false;
      } catch { pssOk = false; }
    }
    return { processes: pids.length, rss_bytes: rss, pss_bytes: pssOk ? pss : null, hwm_bytes: hwm };
  } catch {
    return null;
  }
}

/** Sum of file sizes under a directory (apparent size, like `du -sb`). */
export function dirBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p); else total += st.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}
