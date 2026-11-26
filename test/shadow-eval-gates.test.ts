/**
 * The eval gates half of swap criterion 10 (src/shadow/eval-gates.ts, drill-status.ts; docs/designs/RUST_ENGINE.md "Eval gates").
 *
 * Authoring gate (docs/TESTING.md): (1) protects the swap: criterion 10 passes only for a FINAL gbrain-evals file, all of
 * E1 to E3 PASS, from the build that started the evidence epoch, on the epoch's exact addon and this host's target.
 * (2) Fails when a PROVISIONAL, NOT_RUN, FAIL, malformed, unpinned or altered file passes, when a file for another
 * platform passes (FINAL linux-x64-glibc all PASS on a darwin-arm64 host), when the commit or addon sha may differ from the
 * epoch's, when status or the swap touches the network, or when a failed fetch replaces a good cache. (3) Nothing else
 * covers the criterion's producer: readiness tests hand-write the two booleans. (4) Real files under a temporary
 * directory and the real readiness evaluator; the fetch takes a fake `fetch` (no network).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { buildDrillStatus } from '../src/shadow/drill-status.ts';
import { cachePaths, evalGatesPath, evalGatesUrl, fetchEvalGates, readEvalGatesVerdict } from '../src/shadow/eval-gates.ts';
import { pinDir } from '../src/shadow/eval-gates.ts';
import { shadowStatusDocument } from '../src/shadow/status-document.ts';
import {
  ADDON_SHA, BUILD, COMMIT, EVALS_COMMIT, EVALS_REF, evalUrl, gatesObject, OTHER_ADDON_SHA, OTHER_COMMIT, passGate, pinFor, sha256, TAG, TARGET, writeCache, writeEpoch,
  writeStoreFiles,
} from './helpers/shadow-drill-fixtures.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function shadow(opts: Parameters<typeof writeEpoch>[1] = {}): { dir: string; epoch: ReturnType<typeof writeEpoch> } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-evalgates-'));
  dirs.push(dir);
  writeStoreFiles(dir);
  return { dir, epoch: writeEpoch(dir, opts) };
}
const row10 = (reason: string | null, passed: boolean) => evaluateReadiness({ drills: { backup_restore_passed: true, eval_gates_e1_e3: passed, ...(reason ? { eval_gates_reason: reason } : {}) } } as ShadowStatus).criteria.find(c => c.n === 10)!;

/** Writes the cache for `patch`ed file and pin, then returns the verdict and the readiness row built from the real status. */
function judge(patch: (f: Record<string, unknown>) => void, opts: { epoch?: Parameters<typeof writeEpoch>[1]; host?: string | null; pin?: (p: Record<string, unknown>) => void } = {}) {
  const { dir, epoch } = shadow(opts.epoch);
  const text = JSON.stringify(gatesObject(patch));
  writeCache(dir, text, pinFor(text, opts.pin));
  const verdict = readEvalGatesVerdict(dir, epoch, opts.host === undefined ? TARGET : opts.host);
  const doc = { drills: buildDrillStatus(dir, epoch, opts.host === undefined ? TARGET : opts.host).drills } as ShadowStatus;
  const row = evaluateReadiness({ ...doc, drills: { ...doc.drills, backup_restore_passed: true } }).criteria.find(c => c.n === 10)!;
  return { verdict, row };
}

describe('eval gates verdict', () => {
  test('a FINAL file, all PASS, from the epoch-starting build and addon on this target passes', () => {
    const { verdict, row } = judge(() => undefined);
    expect(verdict).toEqual({ passed: true, reason: null });
    expect(row.state).toBe('pass');
  });

  test('a FINAL linux-x64-glibc all-PASS file on a darwin-arm64 host is NOT READY and names both targets', () => {
    const { verdict, row } = judge(() => undefined, { host: 'darwin-arm64' });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toStartWith('eval_gates_target_mismatch');
    expect(verdict.reason).toContain('linux-x64-glibc');
    expect(verdict.reason).toContain('darwin-arm64');
    expect(row.state).toBe('fail');
    expect(row.detail).toContain('eval_gates_target_mismatch');
  });

  test.each([
    ['a PROVISIONAL file (no tag)', (f: Record<string, unknown>) => { f.status = 'PROVISIONAL'; f.gbrain_tag = null; }, 'eval_gates_provisional'],
    ['a PROVISIONAL status on a tagged file', (f: Record<string, unknown>) => { f.status = 'PROVISIONAL'; }, 'eval_gates_provisional'],
    ['a release candidate tag marked FINAL', (f: Record<string, unknown>) => { f.gbrain_tag = 'v0.60.764.0-rc.1'; }, 'eval_gates_provisional'],
    ['another build\'s commit', (f: Record<string, unknown>) => { f.gbrain_commit = OTHER_COMMIT; }, 'eval_gates_pin_mismatch'],
    ['another addon file', (f: Record<string, unknown>) => { f.rust_addon_sha256 = OTHER_ADDON_SHA; }, 'eval_gates_addon_mismatch'],
    ['another store format', (f: Record<string, unknown>) => { f.engine_format_version = 4; }, 'eval_gates_format_mismatch'],
    ['E2 NOT_RUN', (f: Record<string, unknown>) => { (f.gates as Record<string, unknown>).E2 = { ...passGate(), verdict: 'NOT_RUN' }; }, 'eval_gates_not_run:E2'],
    ['E3 FAIL', (f: Record<string, unknown>) => { (f.gates as Record<string, unknown>).E3 = { ...passGate(), verdict: 'FAIL' }; }, 'eval_gates_failed:E3'],
    ['E1 with a verdict nobody defined', (f: Record<string, unknown>) => { (f.gates as Record<string, unknown>).E1 = { ...passGate(), verdict: 'MAYBE' }; }, 'eval_gates_unreadable'],
    ['a gate that is null', (f: Record<string, unknown>) => { (f.gates as Record<string, unknown>).E1 = null; }, 'eval_gates_unreadable'],
    ['a gate missing', (f: Record<string, unknown>) => { delete (f.gates as Record<string, unknown>).E3; }, 'eval_gates_unreadable'],
    ['a measured value that is text', (f: Record<string, unknown>) => { (f.gates as Record<string, unknown>).E1 = { ...passGate(), measured: '0.95' }; }, 'eval_gates_unreadable'],
    ['an unknown schema version', (f: Record<string, unknown>) => { f.schema_version = 2; }, 'eval_gates_unreadable'],
    ['a null commit', (f: Record<string, unknown>) => { f.gbrain_commit = null; }, 'eval_gates_unreadable'],
  ])('%s is NOT READY with its reason', (_name, patch, reason) => {
    const { verdict, row } = judge(patch);
    expect(verdict).toEqual({ passed: false, reason });
    expect(row.state).toBe('fail');
    expect(row.detail).toContain(reason);
  });

  test('another build\'s commit with a pin that agrees with the file is still refused: the epoch started on a different commit', () => {
    const { verdict } = judge(f => { f.gbrain_commit = OTHER_COMMIT; }, { pin: p => { p.gbrain_commit = OTHER_COMMIT; } });
    expect(verdict.reason).toBe('eval_gates_commit_mismatch');
  });

  test('the build that started the epoch is the one that counts, not the running CLI', () => {
    const { verdict } = judge(() => undefined, { epoch: { build: { ...BUILD, gbrain_commit: OTHER_COMMIT } } });
    expect(verdict.reason).toBe('eval_gates_commit_mismatch');
  });

  test('an epoch with no recorded build, or no epoch at all, is unknown and never a pass', () => {
    expect(judge(() => undefined, { epoch: { build: null } }).verdict.reason).toBe('eval_gates_build_unknown');
    const { dir } = shadow();
    const text = JSON.stringify(gatesObject());
    writeCache(dir, text, pinFor(text));
    expect(readEvalGatesVerdict(dir, null, TARGET).reason).toBe('eval_gates_build_unknown');
  });

  test('an epoch whose addon was unreadable never matches a file', () => {
    expect(judge(() => undefined, { epoch: { addon: 'unreadable' } }).verdict.reason).toBe('eval_gates_addon_mismatch');
    expect(judge(() => undefined, { epoch: { addon: null } }).verdict.reason).toBe('eval_gates_addon_mismatch');
  });

  test('a store with no readable FORMAT cannot match the file\'s format', () => {
    const { dir, epoch } = shadow();
    const text = JSON.stringify(gatesObject());
    writeCache(dir, text, pinFor(text));
    writeFileSync(join(dir, 'store', 'FORMAT'), 'not json');
    expect(readEvalGatesVerdict(dir, epoch, TARGET).reason).toBe('eval_gates_format_mismatch');
  });

  test('missing, unpinned, torn and altered caches fail closed with their reason', () => {
    const { dir, epoch } = shadow();
    expect(readEvalGatesVerdict(dir, epoch, TARGET).reason).toBe('eval_gates_missing');
    const text = JSON.stringify(gatesObject());
    writeCache(dir, text, pinFor(text));
    expect(readEvalGatesVerdict(dir, epoch, TARGET).passed).toBe(true);
    // The file changed after the pin named it (or a write was interrupted between the two files).
    writeFileSync(cachePaths(dir).file, text.replace('0.95', '0.99'));
    expect(readEvalGatesVerdict(dir, epoch, TARGET).reason).toBe('eval_gates_digest_mismatch');
    writeFileSync(cachePaths(dir).file, text);
    writeFileSync(cachePaths(dir).pin, '{"schema_version":1');
    expect(readEvalGatesVerdict(dir, epoch, TARGET).reason).toBe('eval_gates_unreadable');
    rmSync(cachePaths(dir).pin);
    expect(readEvalGatesVerdict(dir, epoch, TARGET).reason).toBe('eval_gates_missing');
  });

  test('a pin whose URL is not the commit-pinned raw path of the file it names is unreadable', () => {
    for (const url of [
      `https://example.test/${EVALS_COMMIT}.json`,
      `http://raw.githubusercontent.com/garrytan/gbrain-evals/${EVALS_REF}/eval/results/engine-bench/eval-gates/${TAG}/${EVALS_COMMIT}.json`,
      `https://raw.githubusercontent.com/garrytan/gbrain-evals/main/eval/results/engine-bench/eval-gates/${TAG}/${EVALS_COMMIT}.json`,
      `https://raw.githubusercontent.com/someone/gbrain-evals/${EVALS_REF}/eval/results/engine-bench/eval-gates/${TAG}/${EVALS_COMMIT}.json`,
    ]) {
      expect(judge(() => undefined, { pin: p => { p.url = url; } }).verdict.reason).toBe('eval_gates_pin_invalid: url');
    }
  });

  test.each([
    ['missing', (p: Record<string, unknown>) => { delete p.evals_ref; }],
    ['null', (p: Record<string, unknown>) => { p.evals_ref = null; }],
    ['a branch name', (p: Record<string, unknown>) => { p.evals_ref = 'main'; }],
    ['39 characters', (p: Record<string, unknown>) => { p.evals_ref = EVALS_REF.slice(1); }],
    ['uppercase hex', (p: Record<string, unknown>) => { p.evals_ref = EVALS_REF.toUpperCase().replace(/F/g, 'A'); }],
    ['a number', (p: Record<string, unknown>) => { p.evals_ref = 7; }],
  ])('a pin whose evals_ref is %s is invalid and NOT READY, naming the field', (_name, patch) => {
    // The URL still names the right file at EVALS_REF, so only the required field is wrong.
    const { verdict, row } = judge(() => undefined, { pin: patch });
    expect(verdict).toEqual({ passed: false, reason: 'eval_gates_pin_invalid: evals_ref' });
    expect(row.state).toBe('fail');
    expect(row.detail).toContain('eval_gates_pin_invalid: evals_ref');
  });

  test('the raw URL is exactly the gbrain-evals contract: evals_ref in the ref, the filename stem is evals_commit', () => {
    expect(evalGatesPath(EVALS_COMMIT, TAG)).toBe(`eval/results/engine-bench/eval-gates/${TAG}/${EVALS_COMMIT}.json`);
    expect(evalGatesUrl(EVALS_REF, evalGatesPath(EVALS_COMMIT, TAG)))
      .toBe(`https://raw.githubusercontent.com/garrytan/gbrain-evals/${EVALS_REF}/eval/results/engine-bench/eval-gates/${TAG}/${EVALS_COMMIT}.json`);
    expect(evalGatesUrl('1'.repeat(40), 'eval/results/engine-bench/eval-gates/v0.60.764.0/2222222222222222222222222222222222222222.json'))
      .toBe('https://raw.githubusercontent.com/garrytan/gbrain-evals/1111111111111111111111111111111111111111/eval/results/engine-bench/eval-gates/v0.60.764.0/2222222222222222222222222222222222222222.json');
  });

  test.each([
    ['missing', (p: Record<string, unknown>) => { delete p.sha256; }],
    ['not hex', (p: Record<string, unknown>) => { p.sha256 = 'z'.repeat(64); }],
    ['too short', (p: Record<string, unknown>) => { p.sha256 = 'a'.repeat(63); }],
  ])('a pin whose sha256 is %s is invalid and NOT READY, naming the field', (_name, patch) => {
    expect(judge(() => undefined, { pin: patch }).verdict).toEqual({ passed: false, reason: 'eval_gates_pin_invalid: sha256' });
  });

  test('a pin sha256 that is not the file\'s is NOT READY with eval_gates_digest_mismatch, from the cache and from a fetch', async () => {
    const wrong = 'a'.repeat(64);
    const judged = judge(() => undefined, { pin: p => { p.sha256 = wrong; } });
    expect(judged.verdict).toEqual({ passed: false, reason: 'eval_gates_digest_mismatch' });
    expect(judged.row.detail).toContain('eval_gates_digest_mismatch');
    const { dir, epoch } = shadow();
    const text = JSON.stringify(gatesObject());
    const routes: Record<string, () => Response> = {
      [`https://github.com/garrytan/gbrain/releases/download/${TAG}/gbrain-eval-gates.pin.json`]: () => new Response(JSON.stringify(pinFor(text, p => { p.sha256 = wrong; }))),
      [evalUrl()]: () => new Response(text),
    };
    expect(await fetchEvalGates(dir, epoch, { fetch: ((async (u: string) => routes[u]!()) as unknown) as typeof fetch, hostTarget: TARGET }))
      .toEqual({ cached: false, reason: 'eval_gates_digest_mismatch', passed: false });
  });

  test('the readiness row prints the reason, and the Nov 28 timing only while the file is missing', () => {
    expect(row10('eval_gates_missing', false).detail).toContain('Sat Nov 28');
    expect(row10('eval_gates_failed:E1', false).detail).not.toContain('Nov 28');
    expect(row10(null, true).state).toBe('pass');
  });
});

describe('status and the swap never fetch', () => {
  test('the status document carries both booleans and reasons, and calls no fetch', async () => {
    const { dir, epoch } = shadow();
    const real = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('status must not touch the network'); }) as unknown as typeof fetch;
    try {
      const doc = await shadowStatusDocument({ key: 'k', dir });
      expect(doc.drills).toMatchObject({ backup_restore_passed: false, eval_gates_e1_e3: false, eval_gates_reason: 'eval_gates_missing', backup_reason: 'backup_drill_missing' });
      expect(doc.drills.eval_gates_reason).toBeDefined();
      expect(epoch.build?.gbrain_commit).toBe(COMMIT);
    } finally { globalThis.fetch = real; }
  });
});

/** A fake `fetch`: URL -> response; redirects and statuses as given. */
function fakeFetch(routes: Record<string, () => Response>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) return new Response('nope', { status: 404 });
    return route();
  }) as unknown as typeof fetch;
}
const pinUrl = `https://github.com/garrytan/gbrain/releases/download/${TAG}/gbrain-eval-gates.pin.json`;
const redirect = (to: string): Response => new Response(null, { status: 302, headers: { location: to } });

describe('fetchEvalGates (drill --evals)', () => {
  const fileText = JSON.stringify(gatesObject());
  const goodRoutes = (): Record<string, () => Response> => ({
    [pinUrl]: () => redirect('https://release-assets.githubusercontent.com/abc'),
    'https://release-assets.githubusercontent.com/abc': () => new Response(JSON.stringify(pinFor(fileText))),
    [evalUrl()]: () => new Response(fileText),
  });

  test('downloads the pin and the file it names, checks the digest and caches both; the verdict then passes offline', async () => {
    const { dir, epoch } = shadow();
    const seen: string[] = [];
    const result = await fetchEvalGates(dir, epoch, { fetch: fakeFetch(goodRoutes(), seen), hostTarget: TARGET, now: () => Date.parse('2026-11-28T12:00:00Z') });
    expect(result).toEqual({ cached: true, reason: null, passed: true });
    expect(seen).toEqual([pinUrl, 'https://release-assets.githubusercontent.com/abc', evalUrl()]);
    expect(readFileSync(cachePaths(dir).file, 'utf8')).toBe(fileText);
    expect(JSON.parse(readFileSync(cachePaths(dir).fetch, 'utf8'))).toEqual({ at: '2026-11-28T12:00:00.000Z', reason: null });
    expect(readEvalGatesVerdict(dir, epoch, TARGET).passed).toBe(true);
  });

  test('a fetched file for another platform is cached but is not a pass on this host', async () => {
    const { dir, epoch } = shadow();
    const result = await fetchEvalGates(dir, epoch, { fetch: fakeFetch(goodRoutes()), hostTarget: 'darwin-arm64' });
    expect(result.cached).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reason).toStartWith('eval_gates_target_mismatch');
  });

  test.each([
    ['no pin on the release (404)', (r: Record<string, () => Response>) => { delete r[pinUrl]; }, 'eval_gates_fetch_http_404'],
    ['a redirect to a host that is not GitHub', (r: Record<string, () => Response>) => { r[pinUrl] = () => redirect('https://evil.example/pin.json'); }, 'eval_gates_fetch_redirect_refused'],
    ['a redirect to plain http', (r: Record<string, () => Response>) => { r[pinUrl] = () => redirect('http://objects.githubusercontent.com/x'); }, 'eval_gates_fetch_redirect_refused'],
    ['a pin over 64 KiB', (r: Record<string, () => Response>) => { r[pinUrl] = () => new Response('x'.repeat(65 * 1024)); }, 'eval_gates_fetch_too_large'],
    ['a pin that is not JSON', (r: Record<string, () => Response>) => { r[pinUrl] = () => new Response('<html>'); }, 'eval_gates_unreadable'],
    ['a pin for another release', (r: Record<string, () => Response>) => { r[pinUrl] = () => new Response(JSON.stringify(pinFor(fileText, p => { p.gbrain_tag = 'v0.1.0'; p.path = p.path; }))); }, 'eval_gates_pin_invalid: path'],
    ['a pin for another commit', (r: Record<string, () => Response>) => { r[pinUrl] = () => new Response(JSON.stringify(pinFor(fileText, p => { p.gbrain_commit = OTHER_COMMIT; }))); }, 'eval_gates_commit_mismatch'],
    ['a file whose bytes differ from the pin', (r: Record<string, () => Response>) => { r[evalUrl()] = () => new Response(fileText + ' '); }, 'eval_gates_digest_mismatch'],
    ['a file that is missing', (r: Record<string, () => Response>) => { delete r[evalUrl()]; }, 'eval_gates_fetch_http_404'],
    ['a file over 1 MiB', (r: Record<string, () => Response>) => { r[evalUrl()] = () => new Response('x'.repeat(1024 * 1024 + 1)); }, 'eval_gates_fetch_too_large'],
  ])('%s: nothing is cached and the reason is recorded', async (_name, tweak, reason) => {
    const { dir, epoch } = shadow();
    const routes = goodRoutes();
    tweak(routes);
    const result = await fetchEvalGates(dir, epoch, { fetch: fakeFetch(routes), hostTarget: TARGET });
    expect(result).toEqual({ cached: false, reason, passed: false });
    expect(readEvalGatesVerdict(dir, epoch, TARGET).reason).toBe('eval_gates_missing');
    expect(JSON.parse(readFileSync(cachePaths(dir).fetch, 'utf8')).reason).toBe(reason);
  });

  test('a pin whose URL uses evals_commit as the ref fails while the file is absent at that commit; the same pin with evals_ref works', async () => {
    // evals_commit names the build the results were measured on; the file is committed afterwards, so it is not at that commit.
    const atEvalsCommit = `https://raw.githubusercontent.com/garrytan/gbrain-evals/${EVALS_COMMIT}/eval/results/engine-bench/eval-gates/${TAG}/${EVALS_COMMIT}.json`;
    const oldStyle = (r: Record<string, () => Response>, pin: Record<string, unknown>): void => { r[pinUrl] = () => new Response(JSON.stringify(pin)); r[atEvalsCommit] = () => new Response('', { status: 404 }); };
    // 1. Old shape: no evals_ref at all.
    const bare = shadow();
    const noRef = goodRoutes();
    oldStyle(noRef, pinFor(fileText, p => { delete p.evals_ref; p.url = atEvalsCommit; }));
    expect(await fetchEvalGates(bare.dir, bare.epoch, { fetch: fakeFetch(noRef), hostTarget: TARGET })).toEqual({ cached: false, reason: 'eval_gates_pin_invalid: evals_ref', passed: false });
    // 2. evals_ref set to evals_commit: well formed, but the file is not there.
    const wrong = shadow();
    const atCommit = goodRoutes();
    oldStyle(atCommit, pinFor(fileText, p => { p.evals_ref = EVALS_COMMIT; p.url = atEvalsCommit; }));
    expect(await fetchEvalGates(wrong.dir, wrong.epoch, { fetch: fakeFetch(atCommit), hostTarget: TARGET })).toEqual({ cached: false, reason: 'eval_gates_fetch_http_404', passed: false });
    expect(readEvalGatesVerdict(wrong.dir, wrong.epoch, TARGET).reason).toBe('eval_gates_missing');
    // 3. The same pin with the evals_ref the publisher read the file at works.
    const right = shadow();
    expect(await fetchEvalGates(right.dir, right.epoch, { fetch: fakeFetch(goodRoutes()), hostTarget: TARGET })).toEqual({ cached: true, reason: null, passed: true });
  });

  test('a failed fetch keeps the good cache that is already there', async () => {
    const { dir, epoch } = shadow();
    expect((await fetchEvalGates(dir, epoch, { fetch: fakeFetch(goodRoutes()), hostTarget: TARGET })).passed).toBe(true);
    const routes = goodRoutes();
    delete routes[pinUrl];
    expect((await fetchEvalGates(dir, epoch, { fetch: fakeFetch(routes), hostTarget: TARGET })).cached).toBe(false);
    expect(readEvalGatesVerdict(dir, epoch, TARGET).passed).toBe(true);
    expect(buildDrillStatus(dir, epoch, TARGET).drills.eval_gates_last_fetch?.reason).toBe('eval_gates_fetch_http_404');
  });

  test('a fetch that throws (offline) and an epoch with no build both cache nothing', async () => {
    const { dir, epoch } = shadow();
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await fetchEvalGates(dir, epoch, { fetch: offline, hostTarget: TARGET })).reason).toBe('eval_gates_fetch_failed');
    const bare = shadow({ build: null });
    expect((await fetchEvalGates(bare.dir, bare.epoch, { fetch: fakeFetch(goodRoutes()), hostTarget: TARGET })).reason).toBe('eval_gates_build_unknown');
  });

  test('a release-candidate build never fetches: its release tag is not a final tag', async () => {
    const { dir, epoch } = shadow({ build: { ...BUILD, gbrain_version: '0.60.764.0-rc.1' } });
    const seen: string[] = [];
    expect((await fetchEvalGates(dir, epoch, { fetch: fakeFetch(goodRoutes(), seen), hostTarget: TARGET })).reason).toBe('eval_gates_provisional');
    expect(seen).toEqual([]);
  });

  test('the file the pin names is cached byte for byte, so its digest keeps matching', async () => {
    const { dir, epoch } = shadow();
    await fetchEvalGates(dir, epoch, { fetch: fakeFetch(goodRoutes()), hostTarget: TARGET });
    expect(sha256(readFileSync(cachePaths(dir).file, 'utf8'))).toBe(JSON.parse(readFileSync(cachePaths(dir).pin, 'utf8')).sha256);
    expect(ADDON_SHA).toHaveLength(64);
  });
});

describe('fetchEvalGates never creates the shadow directory (review round 2)', () => {
  const fileText = JSON.stringify(gatesObject());
  const routes = (during: () => void = () => undefined): Record<string, () => Response> => ({
    [pinUrl]: () => { during(); return new Response(JSON.stringify(pinFor(fileText))); },
    [evalUrl()]: () => new Response(fileText),
  });

  test('a shadow that does not exist is not created, and nothing is fetched', async () => {
    const { dir, epoch } = shadow();
    rmSync(dir, { recursive: true, force: true });
    const seen: string[] = [];
    expect(await fetchEvalGates(dir, epoch, { fetch: fakeFetch(routes(), seen), hostTarget: TARGET })).toEqual({ cached: false, reason: 'shadow_gone', passed: false });
    expect(existsSync(dir)).toBe(false);
    expect(seen).toEqual([]);
  });

  test('without an epoch nothing is created or written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-eval-gates-bare-'));
    dirs.push(dir);
    expect(await fetchEvalGates(dir, null, { fetch: fakeFetch(routes()), hostTarget: TARGET })).toEqual({ cached: false, reason: 'eval_gates_build_unknown', passed: false });
    expect(existsSync(join(dir, 'drills'))).toBe(false);
  });

  test('a shadow deleted while the files download is not recreated, and nothing is cached', async () => {
    const { dir, epoch } = shadow();
    const result = await fetchEvalGates(dir, epoch, { fetch: fakeFetch(routes(() => rmSync(dir, { recursive: true, force: true }))), hostTarget: TARGET });
    expect(result).toEqual({ cached: false, reason: 'shadow_gone', passed: false });
    expect(existsSync(dir)).toBe(false);
  });

  test('a shadow replaced by a new one while the files download gets nothing from the old fetch', async () => {
    const { dir, epoch } = shadow();
    const replace = (): void => { rmSync(dir, { recursive: true, force: true }); mkdirSync(join(dir, 'drills'), { recursive: true }); };
    const result = await fetchEvalGates(dir, epoch, { fetch: fakeFetch(routes(replace)), hostTarget: TARGET });
    expect(result).toEqual({ cached: false, reason: 'shadow_gone', passed: false });
    expect(existsSync(cachePaths(dir).file)).toBe(false);
    expect(existsSync(cachePaths(dir).fetch)).toBe(false);
  });

  test('a drills directory replaced while the files download gets nothing either', async () => {
    const { dir, epoch } = shadow();
    const replace = (): void => { rmSync(join(dir, 'drills'), { recursive: true, force: true }); mkdirSync(join(dir, 'drills')); };
    const result = await fetchEvalGates(dir, epoch, { fetch: fakeFetch(routes(replace)), hostTarget: TARGET });
    expect(result.reason).toBe('shadow_gone');
    expect(existsSync(cachePaths(dir).file)).toBe(false);
  });
});

describe('pinDir tells a directory from one that took its place (ext4 hands a freed inode straight back)', () => {
  const place = (): string => { const base = mkdtempSync(join(tmpdir(), 'gbrain-pin-')); dirs.push(base); const d = join(base, 'd'); mkdirSync(d); return d; };

  test('a pinned directory is live until it is deleted and recreated at the same path', () => {
    const d = place();
    const pin = pinDir(d)!;
    expect(pin.live()).toBe(true);
    rmSync(d, { recursive: true, force: true });
    expect(pin.live()).toBe(false);
    mkdirSync(d);
    expect(pin.live()).toBe(false);
    pin.close();
  });

  test('while a pin is held, no replacement directory is ever given the pinned inode', () => {
    const d = place();
    const pin = pinDir(d)!;
    const pinned = statSync(d).ino;
    for (let i = 0; i < 50; i++) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d);
      expect(statSync(d).ino).not.toBe(pinned);
      expect(pin.live()).toBe(false);
    }
    pin.close();
  });

  test('a pinned directory moved away and replaced is not live; one moved away alone is not live either', () => {
    const d = place();
    const pin = pinDir(d)!;
    renameSync(d, `${d}-moved`);
    expect(pin.live()).toBe(false);
    mkdirSync(d);
    expect(pin.live()).toBe(false);
    pin.close();
  });

  test('a missing path and a plain file have no pin, and a closed pin is never live', () => {
    const d = place();
    writeFileSync(join(d, 'f'), 'x');
    expect(pinDir(join(d, 'absent'))).toBeNull();
    expect(pinDir(join(d, 'f'))).toBeNull();
    const pin = pinDir(d)!;
    pin.close();
    pin.close();
    expect(pin.live()).toBe(false);
  });

  test('pinning writes nothing into the directory', () => {
    const d = place();
    const pin = pinDir(d)!;
    expect(readdirSync(d)).toEqual([]);
    pin.close();
  });
});
