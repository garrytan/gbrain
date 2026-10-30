/**
 * `cron_gbrain_home` (GBRA-108): a cron line, or a script a cron line runs, that calls gbrain without the home this
 * brain lives in. Cron starts commands with a bare environment, so a line that runs `bun run src/cli.ts` straight from
 * a checkout, or the `gbrain` binary while this brain is under a non-default GBRAIN_HOME, reads and writes
 * `~/.gbrain` instead: a second, silent brain state (locks, queue, config) beside the real one.
 *
 * Read-only and bounded: `crontab -l` (5 s; no check unless the crontab mentions gbrain or src/cli.ts), plus at most 20 scripts the lines name (64 KiB
 * each). A line or script counts as setting the home when it assigns GBRAIN_HOME (on the line, in the crontab's
 * environment lines, or anywhere in the script). Warns, never fails; the user edits the crontab.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { execFileSync } from '../../../core/spawn.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';

const SCRIPTS_MAX = 20;
const SCRIPT_BYTES_MAX = 64 * 1024;
const DIRECT_CLI = /(?:^|[\s;&|(=])(?:\S*\/)?src\/cli\.ts\b/;
const BINARY_CALL = /(?:^|[\s;&|(\/])gbrain\s+[a-z]/;
const SETS_HOME = /(?:^|[\s;&|(])(?:export\s+)?GBRAIN_HOME=/;

export interface CronGbrainHomeFinding { where: string; command: string; reason: 'direct_cli' | 'default_home' }

const expand = (path: string) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;

function readScript(path: string): string | null {
  try {
    const file = expand(path);
    if (!isAbsolute(file) || !existsSync(file) || !statSync(file).isFile() || statSync(file).size > SCRIPT_BYTES_MAX) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

/** The command part of a schedule line (after five time fields or an @keyword), or null for env, comment and blank lines. */
function cronCommand(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) return null;
  const at = /^@\w+\s+(.*)$/.exec(trimmed);
  if (at) return at[1]!;
  const fields = trimmed.split(/\s+/);
  return fields.length > 5 ? fields.slice(5).join(' ') : null;
}

/** The first path-like word of a command after any VAR=value prefixes: the script a line runs, if it runs one. */
function scriptOf(command: string): string | null {
  for (const word of command.split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return /^(?:\/|~\/)/.test(word) && !/\/(?:bun|node|bash|sh|zsh|env|gbrain)$/.test(word) ? word : null;
  }
  return null;
}

function classify(command: string, homeSet: boolean, customHome: boolean): CronGbrainHomeFinding['reason'] | null {
  if (homeSet || SETS_HOME.test(command)) return null;
  if (DIRECT_CLI.test(command)) return 'direct_cli';
  return customHome && BINARY_CALL.test(command) ? 'default_home' : null;
}

/** Pure: the findings for one crontab text. `customHome` is this process's GBRAIN_HOME when it is set. */
export function cronGbrainHomeFindings(crontab: string, customHome: string | undefined, read: (path: string) => string | null = readScript): CronGbrainHomeFinding[] {
  const lines = crontab.split('\n');
  const cronHome = lines.some(line => /^\s*GBRAIN_HOME\s*=/.test(line));
  const findings: CronGbrainHomeFinding[] = [];
  let scripts = 0;
  lines.forEach((line, index) => {
    const command = cronCommand(line);
    if (!command) return;
    const reason = classify(command, cronHome, !!customHome);
    if (reason) findings.push({ where: `crontab line ${index + 1}`, command: command.slice(0, 200), reason });
    const script = scriptOf(command);
    if (!script || cronHome || SETS_HOME.test(command) || scripts >= SCRIPTS_MAX) return;
    scripts++;
    const text = read(script);
    if (text === null || SETS_HOME.test(text)) return;
    text.split('\n').forEach((scriptLine, n) => {
      if (scriptLine.trim().startsWith('#')) return;
      const inner = classify(scriptLine, false, !!customHome);
      if (inner) findings.push({ where: `${script}:${n + 1} (run by crontab line ${index + 1})`, command: scriptLine.trim().slice(0, 200), reason: inner });
    });
  });
  return findings;
}

export function cronGbrainHomeCheck(crontab: string | null, customHome: string | undefined, read?: (path: string) => string | null): Check | null {
  if (crontab === null || !/gbrain|src\/cli\.ts/.test(crontab)) return null;
  const findings = cronGbrainHomeFindings(crontab, customHome, read);
  if (!findings.length) return { name: 'cron_gbrain_home', status: 'ok', message: 'No cron line or script it runs calls gbrain without its GBRAIN_HOME.', details: { findings } };
  const home = customHome ? `GBRAIN_HOME=${customHome}` : 'GBRAIN_HOME set to the home this brain uses';
  const listed = findings.slice(0, 5).map(f => `${f.where}: ${f.command}`).join(' | ');
  return { name: 'cron_gbrain_home', status: 'warn', details: { findings, gbrain_home: customHome ?? null },
    message: `${findings.length} cron command(s) run gbrain without GBRAIN_HOME, so they use ~/.gbrain rather than this brain's home: ${listed}${findings.length > 5 ? ' ...' : ''}. `
      + `Cron passes no GBRAIN_HOME of its own; set it on the line or in the script, or call a wrapper that sets it.`,
    fix: { argv: ['crontab', '-e'], consent: [], actor: 'user', requires_exclusive: false,
      why: 'A cron command without GBRAIN_HOME reads and writes a second brain state under ~/.gbrain; only the user edits the crontab.',
      user_message: `These cron commands run gbrain without GBRAIN_HOME: ${listed}. Add ${home} to each (or to the script it runs), or point them at a wrapper that exports it, so they act on this brain.`,
      verify: doctorVerify('cron_gbrain_home') } };
}

/** `crontab -l` on a local machine; null when there is no crontab or it cannot be read in 5 s. */
export function readCrontab(): string | null {
  try { return execFileSync('crontab', ['-l'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).toString(); }
  catch { return null; }
}
