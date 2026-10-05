/**
 * `gbrain archive-crawler check [<path>...]` — the archive-crawler skill's
 * scan_paths safety fence (src/core/archive-crawler-config.ts).
 *
 * The skill is markdown an agent executes, so gbrain cannot intercept the
 * agent's own file reads; this command is the deterministic gate the skill
 * runs before it reads, extracts or files anything. Exit 0 only when the
 * brain repo's gbrain.yml has an archive-crawler.scan_paths allow-list and
 * every path given is allowed; exit 1 otherwise, with the reason.
 */
import { join, resolve } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import {
  ArchiveCrawlerConfigError,
  checkArchivePath,
  loadArchiveCrawlerConfig,
  type ArchiveCrawlerConfig,
  type ArchivePathVerdict,
} from '../core/archive-crawler-config.ts';
import { getDefaultSourcePath } from '../core/source-resolver.ts';
import { setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';

export const ARCHIVE_CRAWLER_HELP = `gbrain archive-crawler — the archive-crawler skill's scan_paths safety fence

USAGE
  gbrain archive-crawler check [<path>...] [--repo <dir> | --source <id>] [--json]

Reads the archive-crawler section of the brain repo's gbrain.yml and decides
each path. A path is allowed only when it resolves (symlinks followed) inside a
scan_paths entry and outside every deny_paths entry. With no path, checks that
the allow-list is configured and prints it.

The archive-crawler skill runs this before it reads, extracts or files anything
from an archive. Exit 0: every path is allowed. Exit 1: the allow-list is
missing or invalid, or a path is refused; do not read or ingest a refused path.

OPTIONS
  --repo <dir>      Brain repo whose gbrain.yml holds the allow-list
  --source <id>     Use this source's local path as the brain repo (default:
                    the current source, resolved as for every source command)
  --json            Machine-readable verdicts
  --help, -h        Show this help
`;

const UNCONFIGURED = `archive-crawler: refusing to run. No \`archive-crawler.scan_paths:\` allow-list
in gbrain.yml. Add explicit paths the agent is permitted to scan, then re-run.
This is a safety fence — the agent will not infer what's safe to read.`;

export interface ArchiveCheckResult {
  ok: boolean;
  repo: string | null;
  scan_paths: string[];
  deny_paths: string[];
  paths: ArchivePathVerdict[];
  error?: { code: ArchiveCrawlerConfigError['code']; message: string };
}

/**
 * Decide `paths` against the allow-list in `repo`/gbrain.yml. Relative
 * paths resolve against `cwd`, the directory the agent's own reads use.
 */
export function runArchiveCheck(repo: string | null, paths: string[], cwd: string = process.cwd()): ArchiveCheckResult {
  let config: ArchiveCrawlerConfig;
  try {
    config = loadArchiveCrawlerConfig(repo);
  } catch (e) {
    if (!(e instanceof ArchiveCrawlerConfigError)) throw e;
    return { ok: false, repo, scan_paths: [], deny_paths: [], paths: [], error: { code: e.code, message: e.message } };
  }
  const verdicts = paths.map((p) => {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- absolutizes the operator's candidate so the fence can judge it; nothing is read here
    const verdict = checkArchivePath(p.startsWith('~') ? p : resolve(cwd, p), config);
    return { ...verdict, path: p };
  });
  return {
    ok: verdicts.every((v) => v.allowed),
    repo,
    scan_paths: config.scan_paths,
    deny_paths: config.deny_paths,
    paths: verdicts,
  };
}

function describeVerdict(v: ArchivePathVerdict): string {
  if (v.allowed) {
    const skip = v.excluded.length > 0 ? ` (skip deny_paths inside it: ${v.excluded.join(', ')})` : '';
    return `allowed  ${v.path}${skip}`;
  }
  const where = v.resolved !== v.path ? ` (resolves to ${v.resolved})` : '';
  if (v.reason === 'denied') return `refused  ${v.path}${where}: inside archive-crawler.deny_paths entry ${v.deny_path}`;
  if (v.reason === 'relative_path') return `refused  ${v.path}: not an absolute path`;
  return `refused  ${v.path}${where}: outside every archive-crawler.scan_paths entry`;
}

export function formatArchiveCheckHuman(result: ArchiveCheckResult): string {
  if (result.error) {
    const unconfigured = result.error.code === 'missing_section' || result.error.code === 'empty_scan_paths';
    return `${unconfigured ? UNCONFIGURED : 'archive-crawler: refusing to run. The archive-crawler section of gbrain.yml is invalid.'}\n${result.error.message}\n`;
  }
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- display only: names the gbrain.yml the allow-list came from
  const lines = [`archive-crawler: allow-list from ${join(result.repo!, 'gbrain.yml')}`];
  lines.push(...result.scan_paths.map((p) => `  scan_paths  ${p}`));
  lines.push(...result.deny_paths.map((p) => `  deny_paths  ${p}`));
  lines.push(...result.paths.map((v) => `archive-crawler: ${describeVerdict(v)}`));
  if (!result.ok) {
    lines.push('Do not read or ingest a refused path. Only the user may change the allow-list in gbrain.yml.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Brain repo resolution: explicit --repo, else the local path of the source
 * the ambient chain picks (`--source` → GBRAIN_SOURCE → .gbrain-source → …;
 * the same lookup `gbrain storage status` uses). An engine is opened only
 * for that fallback.
 */
export async function resolveArchiveRepo(
  opts: { repo?: string; source?: string },
  connectEngine: () => Promise<BrainEngine>,
  release: (engine: BrainEngine) => Promise<void>,
): Promise<string | null> {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- the operator's own --repo on a local CLI; the loader reads only gbrain.yml under it
  if (opts.repo) return resolve(opts.repo);
  const engine = await connectEngine();
  try {
    return await getDefaultSourcePath(engine, process.cwd(), opts.source ?? null);
  } finally {
    await release(engine);
  }
}

const VALUE_FLAGS = ['--repo', '--source'] as const;

export async function runArchiveCrawler(
  args: string[],
  connectEngine: () => Promise<BrainEngine>,
  release: (engine: BrainEngine) => Promise<void>,
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    await writeStdoutFinal(ARCHIVE_CRAWLER_HELP);
    return;
  }
  const [subcommand, ...rest] = args;
  if (subcommand !== 'check') {
    console.error(subcommand ? `Unknown archive-crawler subcommand: ${subcommand}` : 'Missing archive-crawler subcommand.');
    console.error(ARCHIVE_CRAWLER_HELP);
    setCliExitVerdict(2);
    return;
  }
  const values: { repo?: string; source?: string } = {};
  const paths: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i].split(/=(.*)/s, 2);
    if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      const value = inline ?? rest[++i];
      if (!value || value.startsWith('--')) {
        console.error(`${flag} needs a value: gbrain archive-crawler check [<path>...] [--repo <dir> | --source <id>]`);
        setCliExitVerdict(2);
        return;
      }
      values[flag === '--repo' ? 'repo' : 'source'] = value;
    } else if (!rest[i].startsWith('--')) {
      paths.push(rest[i]);
    }
  }

  const repo = await resolveArchiveRepo(values, connectEngine, release);
  const result = runArchiveCheck(repo, paths);
  if (rest.includes('--json')) {
    await writeStdoutFinal(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.error) {
    process.stderr.write(formatArchiveCheckHuman(result));
  } else {
    await writeStdoutFinal(formatArchiveCheckHuman(result));
  }
  if (!result.ok) setCliExitVerdict(1);
}
