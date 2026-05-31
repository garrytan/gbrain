import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

type BaselineFixture = {
  upstream_baseline?: {
    path?: string;
    sha?: string;
    tag?: string;
  };
};

type CheckResult = {
  ok: boolean;
  status: 'matching' | 'drifted' | 'missing_reference' | 'invalid_fixture';
  referencePath: string;
  expected: {
    sha: string;
    tag: string;
  };
  actual?: {
    sha: string;
    tags: string[];
    describe: string;
    dirty: boolean;
    dirtyPaths: string[];
  };
  message: string;
};

const DEFAULT_FIXTURE_PATH = 'test/fixtures/gbrain-absorption/ga-p0-p1.fixture.json';

function readFixture(path: string): BaselineFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineFixture;
}

function gitOutput(referencePath: string, args: string[]): string {
  return execFileSync('git', ['-C', referencePath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function buildResult(): CheckResult {
  const fixturePath = resolve(process.env.GBRAIN_BASELINE_FIXTURE_PATH ?? DEFAULT_FIXTURE_PATH);
  const fixture = readFixture(fixturePath);
  const baseline = fixture.upstream_baseline;
  const expectedSha = baseline?.sha ?? '';
  const expectedTag = baseline?.tag ?? '';
  const baselinePath = baseline?.path ?? 'reference/gbrain';
  const referencePath = resolve(process.env.GBRAIN_REFERENCE_PATH ?? baselinePath);

  if (!expectedSha || !expectedTag) {
    return {
      ok: false,
      status: 'invalid_fixture',
      referencePath,
      expected: { sha: expectedSha, tag: expectedTag },
      message: `Missing upstream_baseline.sha or upstream_baseline.tag in ${fixturePath}`,
    };
  }

  if (!existsSync(referencePath)) {
    return {
      ok: false,
      status: 'missing_reference',
      referencePath,
      expected: { sha: expectedSha, tag: expectedTag },
      message: `Reference checkout not found at ${referencePath}. Set GBRAIN_REFERENCE_PATH to the local gbrain checkout before checking drift.`,
    };
  }

  const actualSha = gitOutput(referencePath, ['rev-parse', 'HEAD']);
  const tags = gitOutput(referencePath, ['tag', '--points-at', 'HEAD'])
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const describe = gitOutput(referencePath, ['describe', '--tags', '--always', '--dirty']);
  const dirtyPaths = gitOutput(referencePath, ['status', '--porcelain'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dirty = dirtyPaths.length > 0;
  const ok = actualSha === expectedSha && tags.includes(expectedTag) && !dirty;

  return {
    ok,
    status: ok ? 'matching' : 'drifted',
    referencePath,
    expected: { sha: expectedSha, tag: expectedTag },
    actual: { sha: actualSha, tags, describe, dirty, dirtyPaths },
    message: ok
      ? 'Local gbrain reference matches the classified absorption baseline.'
      : 'Local gbrain reference differs from the classified absorption baseline or has local modifications. Refresh the classification before claiming parity with this checkout.',
  };
}

const result = buildResult();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
