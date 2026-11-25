/**
 * The eval-gates pin publisher (scripts/eval-gates-pin.ts, .github/workflows/eval-gates-pin.yml; docs/designs/RUST_ENGINE.md "Eval gates").
 *
 * Authoring gate (docs/TESTING.md): (1) protects criterion 10's release handoff: each release gets a pin for ITS OWN FINAL
 * eval file, with a commit-pinned URL and the file's SHA-256, and a pin is never silently replaced. (2) Fails when a file
 * for release A pins release B (or today's VERSION), when a provisional file, a file whose tag moved off its commit, or a
 * misnamed file is pinned, when an existing pin is overwritten, or when the workflow can write outside its publish job.
 * (3) The drill/eval-gates tests cover the consumer; nothing covered the producer. (4) A fake GitHub (`PinSource`); the
 * workflow is read as text.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPin, githubSource, planPins, type PinSource, type ReleaseInfo } from '../scripts/eval-gates-pin.ts';
import { parsePin } from '../src/shadow/eval-gates.ts';
import { COMMIT, EVALS_COMMIT, EVALS_REF, gatesObject, OTHER_COMMIT, sha256 } from './helpers/shadow-drill-fixtures.ts';

const A = 'v0.60.764.0';
const B = 'v0.60.765.0';
const commitOf: Record<string, string> = { [A]: COMMIT, [B]: OTHER_COMMIT };
const fileFor = (tag: string, patch: (f: Record<string, unknown>) => void = () => undefined, evals = EVALS_COMMIT): { name: string; text: string } => ({
  name: `${evals}.json`,
  text: JSON.stringify(gatesObject(f => { f.gbrain_tag = tag; f.gbrain_commit = commitOf[tag]; f.evals_commit = evals; patch(f); })),
});

interface World {
  releases: ReleaseInfo[]; files: Record<string, Array<{ name: string; text: string }>>; tags?: Record<string, string | null>; assets?: Record<string, string>; calls?: string[];
  /** The commit that landed each file, by file name; default EVALS_REF. */
  landed?: Record<string, string | null>;
}
function world(w: World): PinSource {
  const calls = w.calls ?? [];
  return {
    releases: async () => w.releases,
    evalFiles: async tag => { calls.push(`files ${tag}`); return (w.files[tag] ?? []).map(f => f.name); },
    landingCommit: async path => { const name = path.split('/').pop()!; return w.landed && name in w.landed ? w.landed[name]! : EVALS_REF; },
    evalFileText: async (path, ref) => {
      calls.push(`text ${path} ${ref}`);
      const [, , , , tag, name] = path.split('/');
      return (w.files[tag!] ?? []).find(f => f.name === name)!.text;
    },
    tagCommit: async tag => (w.tags && tag in w.tags ? w.tags[tag]! : commitOf[tag] ?? null),
    assetText: async url => w.assets![url]!,
  };
}
const release = (tag: string, withPin = false): ReleaseInfo => ({ tag, assets: withPin ? [{ name: 'gbrain-eval-gates.pin.json', url: `https://api.example.test/${tag}` }] : [{ name: 'gbrain-linux-x64', url: 'u' }] });

describe('planPins', () => {
  test('release A, release B, then A\'s FINAL file: A is pinned, B is left alone', async () => {
    const plan = await planPins(world({ releases: [release(B), release(A)], files: { [A]: [fileFor(A)] } }));
    expect(plan.publish.map(p => p.tag)).toEqual([A]);
    expect(plan.waiting).toEqual([B]);
    const pin = plan.publish[0]!.pin;
    expect(pin).toMatchObject({ gbrain_tag: A, gbrain_commit: COMMIT, evals_commit: EVALS_COMMIT, evals_ref: EVALS_REF, sha256: sha256(fileFor(A).text), target: 'linux-x64-glibc' });
    expect(pin.url).toBe(`https://raw.githubusercontent.com/garrytan/gbrain-evals/${EVALS_REF}/eval/results/engine-bench/eval-gates/${A}/${EVALS_COMMIT}.json`);
    expect(parsePin(JSON.stringify(pin))).not.toBeNull();
  });

  test('a file under A\'s directory that is for release B pins nothing', async () => {
    const plan = await planPins(world({ releases: [release(A)], files: { [A]: [fileFor(B)] } }));
    expect(plan.publish).toEqual([]);
    expect(plan.waiting).toEqual([A]);
  });

  test.each([
    ['a provisional file', (f: Record<string, unknown>) => { f.status = 'PROVISIONAL'; f.gbrain_tag = null; }],
    ['a provisional status on a tagged file', (f: Record<string, unknown>) => { f.status = 'PROVISIONAL'; }],
    ['a file that does not parse', (f: Record<string, unknown>) => { f.gates = null; }],
  ])('%s is not pinned', async (_name, patch) => {
    const plan = await planPins(world({ releases: [release(A)], files: { [A]: [fileFor(A, patch)] } }));
    expect(plan.publish).toEqual([]);
  });

  test('a moved tag (it no longer resolves to the file\'s commit), a missing tag and a misnamed file are not pinned', async () => {
    expect((await planPins(world({ releases: [release(A)], files: { [A]: [fileFor(A)] }, tags: { [A]: OTHER_COMMIT } }))).publish).toEqual([]);
    expect((await planPins(world({ releases: [release(A)], files: { [A]: [fileFor(A)] }, tags: { [A]: null } }))).publish).toEqual([]);
    const misnamed = { ...fileFor(A), name: `${'1'.repeat(40)}.json` };
    expect((await planPins(world({ releases: [release(A)], files: { [A]: [misnamed] } }))).publish).toEqual([]);
  });

  test('evals_ref is the commit that landed the file, so a later run of the publisher gives the same pin', async () => {
    const landed = '9'.repeat(40);
    const first = await planPins(world({ releases: [release(A)], files: { [A]: [fileFor(A)] }, landed: { [fileFor(A).name]: landed } }));
    expect(first.publish[0]!.pin.evals_ref).toBe(landed);
    expect(first.publish[0]!.pin.url).toBe(`https://raw.githubusercontent.com/garrytan/gbrain-evals/${landed}/eval/results/engine-bench/eval-gates/${A}/${EVALS_COMMIT}.json`);
    // Published; main then moves on. The same landing commit gives an identical pin: a no-op, not a conflict.
    const url = `https://api.example.test/${A}`;
    const again = await planPins(world({ releases: [release(A, true)], files: { [A]: [fileFor(A)] }, landed: { [fileFor(A).name]: landed }, assets: { [url]: JSON.stringify(first.publish[0]!.pin) } }));
    expect(again).toMatchObject({ publish: [], unchanged: [A], conflicts: [] });
  });

  test('a file with no landing commit is not pinned', async () => {
    const plan = await planPins(world({ releases: [release(A)], files: { [A]: [fileFor(A)] }, landed: { [fileFor(A).name]: null } }));
    expect(plan.publish).toEqual([]);
  });

  test('the first FINAL file wins, a bad earlier file is skipped, and every file is read at its landing commit', async () => {
    const calls: string[] = [];
    const bad = fileFor(A, f => { f.status = 'PROVISIONAL'; f.generated_at = '2026-11-27T00:00:00Z'; }, '1'.repeat(40));
    const first = fileFor(A, f => { f.generated_at = '2026-11-28T00:00:00Z'; });
    const later = fileFor(A, f => { f.generated_at = '2026-11-29T00:00:00Z'; }, '2'.repeat(40));
    const plan = await planPins(world({ releases: [release(A)], files: { [A]: [later, first, bad] }, calls }));
    expect(plan.publish[0]!.pin.evals_commit).toBe(EVALS_COMMIT);
    expect(calls.filter(c => c.startsWith('text')).every(c => c.endsWith(EVALS_REF))).toBe(true);
  });

  test('an identical existing pin is a no-op; a different one is a conflict and nothing is replaced', async () => {
    const file = fileFor(A);
    const pin = buildPin(A, file.text, file.name, EVALS_REF, COMMIT)!;
    const url = `https://api.example.test/${A}`;
    const same = await planPins(world({ releases: [release(A, true)], files: { [A]: [file] }, assets: { [url]: JSON.stringify(pin, null, 2) } }));
    expect(same).toMatchObject({ publish: [], unchanged: [A], conflicts: [] });
    const other = await planPins(world({ releases: [release(A, true)], files: { [A]: [file] }, assets: { [url]: JSON.stringify({ ...pin, sha256: '0'.repeat(64) }) } }));
    expect(other.publish).toEqual([]);
    expect(other.conflicts).toEqual([{ tag: A, reason: expect.stringContaining(A) }]);
    const unreadable = await planPins(world({ releases: [release(A, true)], files: { [A]: [file] }, assets: { [url]: 'not json' } }));
    expect(unreadable.conflicts).toHaveLength(1);
  });

  test('a release that is pinned and has no file now (the evals repository was cleaned) is left alone', async () => {
    const plan = await planPins(world({ releases: [release(A, true)], files: {} }));
    expect(plan).toMatchObject({ publish: [], unchanged: [A], conflicts: [] });
  });

  test('only the last 100 releases are looked at, and names that are not release tags are ignored', async () => {
    const releases = [...Array.from({ length: 102 }, (_, n) => release(`v0.60.${800 + n}.0`)), release('latest-stable'), release('v1.0.0-rc.1')];
    const calls: string[] = [];
    const plan = await planPins(world({ releases, files: {}, calls }));
    expect(plan.waiting).toHaveLength(100);
    expect(plan.waiting).not.toContain('latest-stable');
    expect(plan.waiting).not.toContain('v1.0.0-rc.1');
  });

  test('a release more than ten newer releases back still gets its pin when its FINAL file lands late', async () => {
    const old = release(A);
    const newer = Array.from({ length: 11 }, (_, n) => release(`v0.60.${900 + n}.0`));
    const plan = await planPins(world({ releases: [...newer, old], files: { [A]: [fileFor(A)] } }));
    expect(plan.publish.map(p => p.tag)).toEqual([A]);
    expect(plan.waiting).toHaveLength(11);
  });
});

describe('githubSource', () => {
  test('a failed HTTP call throws instead of reading as "no file", and a missing directory is empty', async () => {
    const answer = (status: number): typeof fetch => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    await expect(githubSource('t', answer(500)).releases()).rejects.toThrow('500');
    expect(await githubSource('t', answer(404)).evalFiles('v1.0.0')).toEqual([]);
    expect(await githubSource('t', answer(404)).tagCommit('v1.0.0')).toBeNull();
  });

  test('the release list asks for the newest 100 in one page', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => { urls.push(url); return new Response('[]'); }) as unknown as typeof fetch;
    await githubSource('t', fetcher).releases();
    expect(urls).toEqual(['https://api.github.com/repos/garrytan/gbrain/releases?per_page=100']);
  });

  test('the landing commit is the oldest commit that touched the file', async () => {
    const list = [{ sha: '2'.repeat(40) }, { sha: '1'.repeat(40) }];
    const fetcher = (async (url: string) => new Response(JSON.stringify(url.includes('commits?') && url.includes('path=eval%2Fresults') ? list : []))) as unknown as typeof fetch;
    expect(await githubSource('t', fetcher).landingCommit('eval/results/engine-bench/eval-gates/v1.0.0/x.json')).toBe('1'.repeat(40));
    const none = (async () => new Response('[]')) as unknown as typeof fetch;
    expect(await githubSource('t', none).landingCommit('eval/results/x.json')).toBeNull();
  });

  test('an annotated tag is followed to its commit', async () => {
    const routes: Record<string, unknown> = {
      'https://api.github.com/repos/garrytan/gbrain/git/ref/tags/v1.0.0': { object: { type: 'tag', sha: 'T'.repeat(40) } },
      [`https://api.github.com/repos/garrytan/gbrain/git/tags/${'T'.repeat(40)}`]: { object: { type: 'commit', sha: COMMIT } },
    };
    const fetcher = (async (url: string) => new Response(JSON.stringify(routes[url]))) as unknown as typeof fetch;
    expect(await githubSource('t', fetcher).tagCommit('v1.0.0')).toBe(COMMIT);
  });
});

describe('the workflow', () => {
  const wf = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'eval-gates-pin.yml'), 'utf8');
  const release = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8');

  test('runs every 3 hours and on dispatch, and only the publish job can write', () => {
    expect(wf).toMatch(/cron: '\d+ \*\/3 \* \* \*'/);
    expect(wf).toContain('workflow_dispatch:');
    const top = wf.slice(wf.indexOf('permissions:'), wf.indexOf('jobs:'));
    expect(top).toContain('contents: read');
    expect(top).not.toContain('contents: write');
    expect(wf.split('\n').filter(l => /^\s+contents: write/.test(l))).toHaveLength(1);
    expect(wf.slice(wf.indexOf('  publish:'))).toContain('contents: write');
  });

  test('the publish job runs no checked-out code and takes tags from a validated list', () => {
    const publish = wf.slice(wf.indexOf('  publish:'));
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('bun ');
    expect(publish).toContain('refusing tag name');
    expect(publish).not.toMatch(/run: .*\$\{\{/);
  });

  test('release.yml\'s completeness check is a subset check, so the extra pin asset is allowed', () => {
    expect(release).toContain('expected="gbrain-darwin-arm64,gbrain-engine-rust-darwin-arm64.node,gbrain-engine-rust-linux-x64-glibc.node,gbrain-engine-rust.sha256.json,gbrain-linux-x64,gbrain-skill-resolver.mjs,gbrain-skill-resolver.mjs.sha256"');
    expect(release).toContain('complete=true');
    expect(release).not.toContain('[ "$assets" = "gbrain-darwin-arm64');
  });

  // The completeness block of the version job, run for real: an extra asset is fine, any one missing name is not.
  const block = ((): string => {
    const start = release.indexOf('          expected="gbrain-darwin-arm64');
    const end = release.indexOf('          done\n', start) + '          done\n'.length;
    return release.slice(start, end);
  })();
  const complete = (assets: string): string => execFileSync('bash', ['-c', `assets="$1"\n${block}\necho "$complete"`, 'bash', assets], { encoding: 'utf8' }).trim();
  const expected = /expected="([^"]+)"/.exec(block)?.[1]?.split(',') ?? [];

  test('the subset check passes with every expected asset plus an extra one, and fails when any one name is missing', () => {
    expect(expected).toHaveLength(7);
    expect(complete(expected.join(','))).toBe('true');
    expect(complete([...expected, 'gbrain-eval-gates.pin.json'].sort().join(','))).toBe('true');
    for (const name of expected) expect(complete(expected.filter(n => n !== name).join(','))).toBe('false');
    expect(complete('')).toBe('false');
  });
});
