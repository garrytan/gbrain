/**
 * #5855: reading an upgrade target's Bun floor and the host's Bun.
 *
 * Protects: the floor shapes a release can pin (only `>=X.Y.Z`; anything else
 * is unreadable and holds), canary and `--revision` Bun versions ordering by
 * semver, the bun-link reader returning the fetched SHA it read the floor at,
 * the package reader following the global install's pinned spec, the host Bun
 * being the lower of PATH and the running binary, and the refusal wording.
 * Regression: a looser floor parse that reads `^1.4.0` or `--1` as satisfied,
 * a canary read as unparseable (holding forever), a bun-link check that reads
 * the floor of a commit other than the one installed, a PATH-only Bun reading.
 * Existing coverage: none (the readers are new; adapted from PR #5860's tests).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUN_FLOOR_FIX,
  evaluateBunFloor,
  globalGbrainSpec,
  parseReleasePackage,
  rawPackageUrlForSpec,
  readBunLinkTarget,
  readHostBun,
  readPackageTarget,
} from '../src/core/bun-floor.ts';
import { bunVersionMeets, compareBunVersions } from '../src/core/runtime-version.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => { globalThis.fetch = realFetch; });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `gbrain-bun-floor-${label}-`));
  dirs.push(d);
  return d;
}

describe('Bun version ordering', () => {
  test('canary and revision builds parse and order by semver', () => {
    const cases: Array<[string, string, boolean | null]> = [
      ['1.4.0', '1.4.0', true],
      ['1.4.2', '1.4.0', true],
      ['1.4.2+5a1b2c3', '1.4.0', true],
      ['1.3.14', '1.4.0', false],
      ['1.4.0-canary.1', '1.4.0', false],
      ['1.4.0-canary.1+abc', '1.4.0', false],
      ['1.5.0-canary.3+abc', '1.4.0', true],
      ['2.0.0', '1.99.99', true],
      ['bun is great', '1.4.0', null],
      ['', '1.4.0', null],
    ];
    for (const [version, floor, meets] of cases) expect(bunVersionMeets(version, floor), version).toBe(meets);
    expect(compareBunVersions('1.4.0-canary.2', '1.4.0')! < 0).toBe(true);
    expect(compareBunVersions('1.4.2+abc', '1.4.2')).toBe(0);
  });
});

describe('release package.json', () => {
  test('only a `>=X.Y.Z` engines.bun floor is read; every other shape is null', () => {
    const cases: Array<[string, string | null]> = [
      [JSON.stringify({ name: 'gbrain', version: '0.61.0.0', engines: { bun: '>=1.4.0' } }), '1.4.0'],
      [JSON.stringify({ engines: { bun: '>= 1.5.1' } }), '1.5.1'],
      [JSON.stringify({ engines: { node: '>=20' } }), null],
      [JSON.stringify({ engines: { bun: 140 } }), null],
      [JSON.stringify({ engines: { bun: '*' } }), null],
      [JSON.stringify({ engines: { bun: '^1.4.0' } }), null],
      [JSON.stringify({ engines: { bun: '>=1.4.0 <2' } }), null],
      [JSON.stringify({ engines: { bun: '=>1.4.0' } }), null],
      [JSON.stringify({ engines: { bun: '--1' } }), null],
      [JSON.stringify({ engines: { bun: '$(rm -rf /)' } }), null],
      [JSON.stringify({ engines: { bun: `>=${'1'.repeat(200)}.0.0` } }), null],
      ['<html>rate limited</html>', null],
      [`{"engines":{"bun":">=1.4.0"},"pad":"${'x'.repeat(300_000)}"}`, null],
    ];
    for (const [body, floor] of cases) expect(parseReleasePackage(body).floor, body.slice(0, 60)).toBe(floor);
    expect(parseReleasePackage(cases[0][0]).version).toBe('0.61.0.0');
  });

  test('a GitHub spec maps to package.json at the ref it installs; other specs are unreadable', () => {
    expect(rawPackageUrlForSpec('github:aimonk2025/gbrain')).toBe('https://raw.githubusercontent.com/aimonk2025/gbrain/HEAD/package.json');
    expect(rawPackageUrlForSpec('github:aimonk2025/gbrain#v0.51.0')).toBe('https://raw.githubusercontent.com/aimonk2025/gbrain/v0.51.0/package.json');
    expect(rawPackageUrlForSpec('git+https://github.com/acme-example/gbrain-fork.git#main')).toBe('https://raw.githubusercontent.com/acme-example/gbrain-fork/main/package.json');
    expect(rawPackageUrlForSpec('^1.3.0')).toBeNull();
    expect(rawPackageUrlForSpec('github:aimonk2025/gbrain#../../x')).toBeNull();
  });

  test('the package reader fetches the pinned ref of the global install and fails closed', async () => {
    const root = tmp('global');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { gbrain: 'github:aimonk2025/gbrain#v0.70.0' } }));
    expect(globalGbrainSpec(root)).toBe('github:aimonk2025/gbrain#v0.70.0');
    const fetched: string[] = [];
    globalThis.fetch = (async (url: any) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ version: '0.70.0.0', engines: { bun: '>=1.6.0' } }));
    }) as typeof fetch;
    expect(await readPackageTarget(globalGbrainSpec(root))).toEqual({ ok: true, floor: '1.6.0', version: '0.70.0.0' });
    expect(fetched).toEqual(['https://raw.githubusercontent.com/aimonk2025/gbrain/v0.70.0/package.json']);

    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;
    expect(await readPackageTarget(null)).toEqual({ ok: false, failedRead: 'GET https://raw.githubusercontent.com/aimonk2025/gbrain/HEAD/package.json returned HTTP 404' });
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect((await readPackageTarget(null)).ok).toBe(false);
    expect((await readPackageTarget('^1.3.0')).ok).toBe(false);
  });
});

describe('bun-link target', () => {
  test('reads the floor at the fetched upstream SHA, not the checkout; no upstream is unreadable', async () => {
    const root = tmp('bunlink');
    const origin = join(root, 'origin');
    mkdirSync(origin);
    const upstream = await makeGitFixture(origin);
    writeFileSync(join(origin, 'package.json'), JSON.stringify({ version: '0.60.0.0', engines: { bun: '>=1.4.0' } }));
    upstream.commitAll('floor 1.4.0');
    const clone = join(root, 'clone');
    execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
    writeFileSync(join(origin, 'package.json'), JSON.stringify({ version: '0.61.0.0', engines: { bun: '>=1.9.0' } }));
    upstream.commitAll('floor 1.9.0');
    const originHead = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    expect(readBunLinkTarget(clone)).toEqual({ sha: originHead, target: { ok: true, floor: '1.9.0', version: '0.61.0.0' } });

    execFileSync('git', ['-C', clone, 'checkout', '-q', '-b', 'no-upstream'], { stdio: 'ignore' });
    expect(readBunLinkTarget(clone)).toEqual({ sha: null, target: { ok: false, failedRead: 'the source clone has no upstream branch to read' } });
  });
});

describe('host Bun', () => {
  test('the lower of the bun on PATH and the running Bun decides; an unrunnable PATH bun is null', async () => {
    const dir = tmp('path-bun');
    const bun = join(dir, 'bun');
    const stub = (body: string | null) => {
      rmSync(bun, { force: true });
      if (body) writeFileSync(bun, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    stub('echo 1.3.14');
    expect(await withEnv({ PATH: dir }, () => readHostBun())).toEqual({ label: 'bun on PATH', path: bun, version: '1.3.14' });
    stub('echo 1.3.14+5a1b2c3');
    expect((await withEnv({ PATH: dir }, () => readHostBun()))?.version).toBe('1.3.14+5a1b2c3');
    stub('echo 99.0.0');
    const running = await withEnv({ PATH: dir }, () => readHostBun());
    expect(running?.label).toBe('the running Bun');
    expect(running?.path).toBe(process.execPath);
    expect(running?.version.split('+')[0]).toBe(Bun.version);
    for (const body of ['echo "bun is great"', 'exit 1', null]) {
      stub(body);
      expect(await withEnv({ PATH: dir }, () => readHostBun()), String(body)).toBeNull();
    }
  });
});

describe('refusal wording', () => {
  test('names the target, floor, Bun found with its path, the fix and the docs; the audit copy drops the path', () => {
    const verdict = evaluateBunFloor({ ok: true, floor: '1.4.0', version: '0.61.0.0' }, { label: 'bun on PATH', path: '/opt/bun/bin/bun', version: '1.3.14' });
    expect(verdict).toEqual({
      ok: false,
      kind: 'unmet',
      message: 'foresights 0.61.0.0 requires Bun >=1.4.0; bun on PATH (/opt/bun/bin/bun) is 1.3.14. Fix: bun upgrade, then foresights upgrade. Docs: docs/guides/upgrades-auto-update.md#bun-floor',
      auditReason: `foresights 0.61.0.0 requires Bun >=1.4.0; bun on PATH is 1.3.14. ${BUN_FLOOR_FIX}`,
    });
    expect(evaluateBunFloor({ ok: true, floor: '1.4.0', version: null }, { label: 'bun on PATH', path: '/b', version: '1.4.0' })).toEqual({ ok: true });
    const unreadable = evaluateBunFloor({ ok: false, failedRead: '`git fetch` in the source clone failed' }, null, '0.99.0.0');
    expect(unreadable.ok || unreadable.message).toBe('Could not read the Bun floor of foresights 0.99.0.0: `git fetch` in the source clone failed. Docs: docs/guides/upgrades-auto-update.md#bun-floor');
    const noBun = evaluateBunFloor({ ok: true, floor: '1.4.0', version: '0.61.0.0' }, null);
    expect(noBun.ok || noBun.kind).toBe('unreadable');
    expect(noBun.ok || noBun.message).toContain('could not run `bun --version` on PATH');
  });
});
