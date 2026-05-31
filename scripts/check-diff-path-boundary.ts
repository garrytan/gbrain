import { execFileSync } from 'child_process';

type Result = {
  ok: boolean;
  baseRef: string;
  changedPaths: string[];
  disallowedPrefixes: string[];
  violations: string[];
  message: string;
};

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readChangedPaths(baseRef: string): string[] {
  const injected = parseList(process.env.MBRAIN_CHANGED_PATHS);
  if (injected.length > 0) return injected.sort();

  const committed = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const unstaged = execFileSync('git', ['diff', '--name-only'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const staged = execFileSync('git', ['diff', '--name-only', '--cached'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return [...new Set(`${committed}\n${unstaged}\n${staged}\n${untracked}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))]
    .sort();
}

const baseRef = process.env.MBRAIN_CHANGED_PATH_BASE ?? 'origin/master';
const disallowedPrefixes = parseList(process.env.MBRAIN_DISALLOWED_PATH_PREFIXES);
const changedPaths = readChangedPaths(baseRef);
const violations = changedPaths.filter((path) => (
  disallowedPrefixes.some((prefix) => path.startsWith(prefix))
));
const result: Result = {
  ok: violations.length === 0,
  baseRef,
  changedPaths,
  disallowedPrefixes,
  violations,
  message: violations.length === 0
    ? 'Changed paths satisfy the configured boundary.'
    : 'Changed paths crossed a configured disallowed prefix.',
};

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
