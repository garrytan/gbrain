/**
 * GBRA-175: the stable release channel on the client side: which release the
 * annotated `stable` tag names, and the `--channel` argument. gbrain upgrade
 * installs it; .github/workflows/promote-stable.yml moves the tag.
 */
import { spawnSync } from './spawn.ts';
import { gitChildEnv } from './git-env.ts';
import { isNewerVersion } from './semver.ts';
import { normalizeChannel, type ReleaseChannel } from './self-upgrade.ts';

const GBRAIN_GIT_URL = 'https://github.com/garrytan/gbrain';
export type GitRunner = (args: string[]) => { status: number | null; stdout: string };
const runGit: GitRunner = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf-8', env: gitChildEnv(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/** GBRA-175: `--channel <name>` / `--channel=<name>`; null when absent, 'invalid' for anything but latest or stable. */
export function parseChannelArg(args: readonly string[]): ReleaseChannel | 'invalid' | null {
  const at = args.findIndex(a => a === '--channel' || a.startsWith('--channel='));
  if (at === -1) return null;
  const raw = args[at]!.includes('=') ? args[at]!.slice('--channel='.length) : args[at + 1];
  return normalizeChannel(raw) ?? 'invalid';
}

export function stableUnresolvedMessage(error: 'unreadable' | 'no_stable' | 'no_release_tag'): string {
  if (error === 'unreadable') return `The stable channel could not be read: \`git ls-remote --tags ${GBRAIN_GIT_URL}\` failed (offline, or no git).`;
  if (error === 'no_stable') return 'No release has been promoted to the stable channel yet (the repository has no `stable` tag).';
  return 'The `stable` tag does not point at a published release commit (no `v<version>` tag shares its commit).';
}

/**
 * GBRA-175: the release the stable channel names: the `v<version>` tag on the commit `refs/tags/stable` peels to
 * (the newest when several share it). promote-stable.yml moves `stable` only to a published release whose exact
 * tree passed the soak.
 */
export function resolveStableRelease(git: GitRunner = runGit): { version: string; commit: string } | { error: 'unreadable' | 'no_stable' | 'no_release_tag' } {
  const { status, stdout } = git(['ls-remote', '--tags', GBRAIN_GIT_URL]);
  if (status !== 0) return { error: 'unreadable' };
  const refs = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.trim().split('\t');
    if (sha && ref) refs.set(ref, sha);
  }
  const peel = (tag: string) => refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  const commit = peel('stable');
  if (!commit) return { error: 'no_stable' };
  let best: string | null = null;
  for (const ref of refs.keys()) {
    const v = /^refs\/tags\/v(\d+\.\d+\.\d+(?:\.\d+)?)$/.exec(ref)?.[1];
    if (v && peel(`v${v}`) === commit && (!best || isNewerVersion(best, v))) best = v;
  }
  return best ? { version: best, commit } : { error: 'no_release_tag' };
}
