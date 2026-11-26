/**
 * scripts/check-silent-read-catches.ts: which catch blocks and `.catch(fn)` handlers count as "a failed read
 * answers nothing", the `path#function` keys, the opt-out marker, the write-only list, the rule plug-in point,
 * and the CLI (new site, baselined site, stale row), driven through GBRAIN_GUARD_ROOT temp trees. The named
 * audit sites (docs/research/gbrain-behavior-audit.md "The silent-failure class") are pinned against code
 * copied verbatim from master in test/fixtures/silent-read-catches/audit-sites/.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { riseFix, scanFile, scanTree } from '../../scripts/check-silent-read-catches.ts';
import { SILENT_READ_RULES, WRITE_ONLY_METHODS, isReadShaped, type SilentReadRule } from '../../scripts/silent-read-rules.ts';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-silent-read-catches.ts');
const HEADER = '# fixture baseline';
const tempDirs: string[] = [];
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** `key metric count` lines for one source text. */
const scan = (src: string, rel = 'src/x.ts') => [...scanFile(src, rel).counts].map(([k, n]) => `${k.replace('\t', ' ')} ${n}`).sort();

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-silent-read-'));
  tempDirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function runGuard(files: Record<string, string>, baseline: string[] = [], args: string[] = []) {
  const root = tree({ ...files, 'scripts/silent-read-catches-baseline.tsv': [HEADER, ...baseline].join('\n') + '\n' });
  const r = spawnSync('bun', [GUARD, ...args], { env: { ...process.env, GBRAIN_GUARD_ROOT: root }, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), root };
}

const SILENT = "export async function f(engine: any) { try { return await engine.getPage('a'); } catch { return []; } }\n";

describe('what counts', () => {
  test('a return of an empty answer around a read counts, in every empty form', () => {
    for (const empty of ['[]', '{}', 'null', 'undefined', '0', 'false', "'ok'", "{ status: 'ok', message: 'Skipped' }", 'new Map()', 'new Set()', '[] as string[]', ';']) {
      const ret = empty === ';' ? 'return;' : `return ${empty};`;
      expect(scan(`export async function f(engine: any) { try { return await engine.getPage('a'); } catch (e) { ${ret} } }`)).toEqual(['src/x.ts#f catch_empty 1']);
    }
  });

  test('a non-empty fallback, a degraded marker and a rethrow do not count', () => {
    for (const body of ["return ['fallback'];", "return { rows: [], degraded: true };", 'throw e;', 'markDegraded(); return [];', 'console.warn(e); return [];']) {
      expect(scan(`export async function f(engine: any) { try { return await engine.getPage('a'); } catch (e) { ${body} } }`)).toEqual([]);
    }
  });

  test('a catch around code that reads nothing from the brain is not counted', () => {
    expect(scan('export function f(t: string) { try { return JSON.parse(t); } catch { return {}; } }')).toEqual([]);
    expect(scan("import { resolve } from 'node:path'; export function f(a: string) { try { return resolve(a); } catch { return null; } }")).toEqual([]);
    expect(scan("export function f(m: Map<string, number>) { try { return m.get('a'); } catch { return null; } }")).toEqual([]);
  });

  test('an empty catch around a read counts, with or without an initialized fallback (A1)', () => {
    expect(scan('export async function f(engine: any) { try { await engine.listPages(); } catch {} }')).toEqual(['src/x.ts#f catch_empty 1']);
    expect(scan('export async function f(engine: any) { try { await engine.listPages(); } catch { /* nothing to do */ } }')).toEqual(['src/x.ts#f catch_empty 1']);
    expect(scan('export async function f(engine: any) { let rows: string[] = []; try { rows = await engine.listPages(); } catch {} return rows; }')).toEqual(['src/x.ts#f catch_empty 1']);
    expect(scan('export async function f(engine: any) { try { await engine.listPages(); } catch (e) { rethrowCapabilityRefusal(e); } }')).toEqual(['src/x.ts#f catch_empty 1']);
    expect(scan('export function f(path: string) { try { return readFileSync(path, "utf8"); } catch { } }')).toEqual(['src/x.ts#f catch_empty 1']);
  });

  test('a leading rethrowCapabilityRefusal does not exempt a handler that then answers empty', () => {
    expect(scan('export async function f(engine: any) { try { return await engine.getPage("a"); } catch (e) { rethrowCapabilityRefusal(e); return null; } }')).toEqual(['src/x.ts#f catch_empty 1']);
  });

  test('an inline catch whose body is only the conditional rethrow helper counts, like its braced form', () => {
    // The helper rethrows a capability refusal and returns undefined for any other failure, so the caller gets an empty answer.
    expect(scan('export function f(engine: any) { return engine.listPages().catch(err => rethrowCapabilityRefusal(err)); }')).toEqual(['src/x.ts#f promise_catch_empty 1']);
    expect(scan('export function f(engine: any) { return engine.listPages().catch(err => { rethrowCapabilityRefusal(err); }); }')).toEqual(['src/x.ts#f promise_catch_empty 1']);
    expect(scan('export function f(engine: any) { return engine.listPages().catch(err => { return rethrowCapabilityRefusal(err); }); }')).toEqual(['src/x.ts#f promise_catch_empty 1']);
    // A call that is not a rethrow helper is not an empty answer.
    expect(scan('export function f(engine: any) { return engine.listPages().catch(err => report(err)); }')).toEqual([]);
  });

  test('an assignment of an empty answer counts; a doctor-style ok result counts', () => {
    expect(scan('export async function f(engine: any) { let n: any = 1; try { n = await engine.getCount(); } catch { n = 0; } return n; }')).toEqual(['src/x.ts#f catch_empty 1']);
    expect(scan("export async function check(engine: any, checks: any[]) { try { await engine.executeRaw('select 1'); } catch (err) { const msg = String(err); checks.push({ name: 'x', status: 'ok', message: `Skipped (${msg})` }); } }")).toEqual(['src/x.ts#check capability_refusal_swallowed 1', 'src/x.ts#check catch_empty 1']);
    expect(scan("export async function check(engine: any) { try { await engine.executeRaw('select 1'); return { name: 'x', status: 'warn' }; } catch (e) { return { name: 'x', status: 'ok', message: 'Skipped' }; } }")).toEqual(['src/x.ts#check capability_refusal_swallowed 1', 'src/x.ts#check catch_empty 1']);
  });

  test('bounded local fallbacks count: new Map(), new Set() and an initialized array, declared before the try in the same function', () => {
    expect(scan('export async function f(engine: any) { const m = new Map<number, string>(); try { return await engine.supersedingPageSlugs([1]); } catch { return m; } }')).toEqual(['src/x.ts#f catch_empty 1']);
    expect(scan('export async function f(engine: any) { const s = new Set<string>(); try { return await engine.listSlugs(); } catch { return s; } }')).toEqual(['src/x.ts#f catch_empty 1']);
    expect(scan('export async function f(engine: any) { let rows: string[] = []; try { return await engine.listPages(); } catch { return rows; } }')).toEqual(['src/x.ts#f catch_empty 1']);
    // declared after the try, declared in another function, or initialized to something non-empty: not a bounded empty fallback
    expect(scan('export async function f(engine: any) { try { return await engine.listPages(); } catch { return rows; } const rows: string[] = []; }')).toEqual([]);
    expect(scan('const outer: string[] = []; export async function f(engine: any) { try { return await engine.listPages(); } catch { return outer; } }')).toEqual([]);
    expect(scan("export async function f(engine: any) { const d = ['x']; try { return await engine.listPages(); } catch { return d; } }")).toEqual([]);
  });

  test('promise handlers count: arrow and function forms, with a local receiver judged by its initializer', () => {
    expect(scan('export function f(engine: any) { return engine.getLinks("a").catch(() => []); }')).toEqual(['src/x.ts#f promise_catch_empty 1']);
    expect(scan('export function f(engine: any) { return engine.getLinks("a").catch(() => {}); }')).toEqual(['src/x.ts#f promise_catch_empty 1']);
    expect(scan('export function f(engine: any) { return engine.getLinks("a").catch(function () { return null; }); }')).toEqual(['src/x.ts#f promise_catch_empty 1']);
    expect(scan('export function f(engine: any) { const p = loadPageTrust(engine, []); p.catch(() => {}); return p; }')).toEqual(['src/x.ts#f promise_catch_empty 1']);
    expect(scan('export function f(engine: any) { return engine.getLinks("a").catch(() => ["x"]); }')).toEqual([]);
    expect(scan('export function f(p: Promise<void>) { return p.catch(() => {}); }')).toEqual([]);
    expect(scan('export function f(engine: any) { return engine.getLinks("a").catch(console.error); }')).toEqual([]);
  });

  test('the two forms keep separate metrics', () => {
    expect(scan('export async function f(engine: any) { await engine.getLinks("a").catch(() => []); try { await engine.getPage("a"); } catch {} }'))
      .toEqual(['src/x.ts#f catch_empty 1', 'src/x.ts#f promise_catch_empty 1']);
  });
});

describe('write-only exclusion (one named list)', () => {
  test('a listed write-only method is skipped', () => {
    expect(WRITE_ONLY_METHODS.get('setConfig')).toBeTruthy();
    expect(scan("export async function f(engine: any) { try { await engine.setConfig('k', 'v'); } catch { return false; } return true; }")).toEqual([]);
  });

  test('an unlisted look-alike still counts', () => {
    for (const name of ['setConfigLike', 'writeConfig']) {
      expect(WRITE_ONLY_METHODS.has(name)).toBe(false);
      expect(scan(`export async function f(engine: any) { try { await engine.${name}('k', 'v'); } catch { return false; } return true; }`)).toEqual(['src/x.ts#f catch_empty 1']);
    }
  });

  test('every entry has a reason', () => {
    for (const [method, reason] of WRITE_ONLY_METHODS) expect(`${method}: ${reason}`).toMatch(/^\w+: \S.*\S$/);
  });
});

describe('keys: path#function', () => {
  test('class methods, nested functions, const arrows and object members', () => {
    const src = [
      'export class A { async load(engine: any) { try { return await engine.getPage("a"); } catch { return null; } } }',
      'export class B { async load(engine: any) { try { return await engine.getPage("a"); } catch { return null; } } }',
      'export async function outer(engine: any) { async function inner() { try { return await engine.getPage("a"); } catch { return null; } } return inner(); }',
      'export const arrow = async (engine: any) => { try { return await engine.getPage("a"); } catch { return null; } };',
      'export const checks = { run: async (engine: any) => { try { return await engine.getPage("a"); } catch { return null; } } };',
      'try { await engine.getPage("a"); } catch {}',
    ].join('\n');
    expect(scan(src)).toEqual([
      'src/x.ts#<module> catch_empty 1',
      'src/x.ts#A.load catch_empty 1',
      'src/x.ts#B.load catch_empty 1',
      'src/x.ts#arrow catch_empty 1',
      'src/x.ts#checks.run catch_empty 1',
      'src/x.ts#outer>inner catch_empty 1',
    ]);
  });

  test('anonymous callbacks get distinct keys by order under their enclosing function', () => {
    const src = [
      'export async function run(engine: any, xs: string[]) {',
      '  await Promise.all(xs.map(async (x) => { try { return await engine.getPage(x); } catch { return null; } }));',
      '  await Promise.all(xs.map(async (x) => { try { return await engine.getLinks(x); } catch { return []; } }));',
      '  await Promise.all(xs.map(async (x) => { try { return await engine.getTags(x); } catch { return []; } }));',
      '}',
    ].join('\n');
    expect(scan(src)).toEqual(['src/x.ts#run<anon@1> catch_empty 1', 'src/x.ts#run<anon@2> catch_empty 1', 'src/x.ts#run<anon@3> catch_empty 1']);
  });

  test('two sites in one function share one key and add up; a function rename moves the key', () => {
    const two = 'export async function f(engine: any) { try { await engine.getPage("a"); } catch {} try { await engine.getPage("b"); } catch {} }';
    expect(scan(two)).toEqual(['src/x.ts#f catch_empty 2']);
    expect(scan(two.replace('function f', 'function g'))).toEqual(['src/x.ts#g catch_empty 2']);
  });
});

describe('opt-out marker and the CLI', () => {
  test('a new site fails with the file, function, metric and the fix', () => {
    const r = runGuard({ 'src/a.ts': SILENT });
    expect(r.status).toBe(1);
    expect(r.out).toContain('FAIL: src/a.ts#f catch_empty: baseline 0, actual 1');
    expect(r.out).toContain('typed degraded marker');
    expect(r.out).toContain('docs/ci-guards.md#silent-read-catches');
  });

  test('a baselined site passes; a count above its row fails; a stale row fails', () => {
    expect(runGuard({ 'src/a.ts': SILENT }, ['src/a.ts#f\tcatch_empty\t1']).status).toBe(0);
    const two = SILENT.replace('try {', 'try { await engine.getPage("b"); } catch {} try {');
    expect(runGuard({ 'src/a.ts': two }, ['src/a.ts#f\tcatch_empty\t1']).out).toContain('baseline 1, actual 2');
    const stale = runGuard({ 'src/a.ts': 'export const ok = 1;\n' }, ['src/a.ts#f\tcatch_empty\t1']);
    expect(stale.status).toBe(1);
    expect(stale.out).toContain('stale row');
  });

  test('rows are keyed by metric: a row for one metric never covers the other', () => {
    const r = runGuard({ 'src/a.ts': SILENT }, ['src/a.ts#f\tpromise_catch_empty\t1']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/a.ts#f catch_empty: baseline 0, actual 1');
  });

  test('a silent-read-ok marker with a reason passes, on the catch line or the line above', () => {
    const above = 'export async function f(engine: any) {\n  try { return await engine.getPage("a"); }\n  // silent-read-ok: the table does not exist before migration 104\n  catch { return []; }\n}\n';
    const same = 'export async function f(engine: any) {\n  try { return await engine.getPage("a"); } catch { return []; } // silent-read-ok: pre-migration brain has no pages table\n}\n';
    expect(runGuard({ 'src/a.ts': above }).status).toBe(0);
    expect(runGuard({ 'src/a.ts': same }).status).toBe(0);
    const promise = 'export function f(engine: any) {\n  // silent-read-ok: a missing table is an empty list\n  return engine.getLinks("a").catch(() => []);\n}\n';
    expect(runGuard({ 'src/a.ts': promise }).status).toBe(0);
  });

  test('a marker two lines away does not apply', () => {
    const far = 'export async function f(engine: any) {\n  // silent-read-ok: too far above\n  const x = 1;\n  try { return await engine.getPage("a"); } catch { return []; }\n}\n';
    expect(runGuard({ 'src/a.ts': far }).status).toBe(1);
  });

  test('an empty reason fails, even for a baselined site', () => {
    for (const marker of ['// silent-read-ok:', '// silent-read-ok', '// silent-read-ok:   ', '/* silent-read-ok: */']) {
      const src = `export async function f(engine: any) {\n  ${marker}\n  try { return await engine.getPage("a"); } catch { return []; }\n}\n`;
      const r = runGuard({ 'src/a.ts': src }, ['src/a.ts#f\tcatch_empty\t1']);
      expect(r.status).toBe(1);
      expect(r.out).toContain('needs a reason');
    }
  });

  test('an inline block-comment marker takes its reason only from inside the comment', () => {
    const inline = (marker: string) => `export async function f(engine: any) {\n  try { return await engine.getPage("a"); } catch { ${marker} return []; }\n}\n`;
    for (const marker of ['/* silent-read-ok: */', '/* silent-read-ok:*/', '/* silent-read-ok */', '/*silent-read-ok:   */']) {
      for (const baseline of [[], ['src/a.ts#f\tcatch_empty\t1']]) {
        const r = runGuard({ 'src/a.ts': inline(marker) }, baseline);
        expect({ marker, status: r.status, needsReason: r.out.includes('needs a reason') }).toEqual({ marker, status: 1, needsReason: true });
      }
    }
    // a reason inside the comment still passes, and so does one in a line comment after the code
    expect(runGuard({ 'src/a.ts': inline('/* silent-read-ok: a pre-migration brain has no pages table */') }).status).toBe(0);
    expect(runGuard({ 'src/a.ts': inline('/* silent-read-ok: pre-migration brain */') }).out).not.toContain('needs a reason');
    const after = 'export async function f(engine: any) {\n  try { return await engine.getPage("a"); } catch { return []; } // silent-read-ok: pre-migration brain has no pages table\n}\n';
    expect(runGuard({ 'src/a.ts': after }).status).toBe(0);
  });

  test('--print lists rows, --list lists sites with lines, --prune lowers a stale row', () => {
    const printed = runGuard({ 'src/a.ts': SILENT }, [], ['--print']);
    expect(printed.out).toContain('src/a.ts#f\tcatch_empty\t1');
    expect(runGuard({ 'src/a.ts': SILENT }, [], ['--list']).out).toContain('src/a.ts:1\tsrc/a.ts#f\tcatch_empty');
    const pruned = runGuard({ 'src/a.ts': 'export const ok = 1;\n' }, ['src/a.ts#f\tcatch_empty\t1'], ['--prune']);
    expect(pruned.status).toBe(0);
    expect(pruned.out).toContain('pruned 1 row');
  });

  test('generated files and declaration files are not scanned', () => {
    expect(runGuard({ 'src/schema.generated.ts': SILENT, 'src/types.d.ts': 'export {};\n' }).status).toBe(0);
  });
});

describe('plug-in point', () => {
  test('rule names and metrics are unique, and the baseline metrics are the rules\' metrics', () => {
    expect(new Set(SILENT_READ_RULES.map(r => r.name)).size).toBe(SILENT_READ_RULES.length);
    expect(new Set(SILENT_READ_RULES.map(r => r.metric)).size).toBe(SILENT_READ_RULES.length);
    expect(SILENT_READ_RULES.map(r => r.metric)).toEqual(['catch_empty', 'promise_catch_empty', 'capability_refusal_swallowed']);
  });

  test('the capability-refusal rule is registered: it counts in a scan, under its own metric and opt-out marker', () => {
    const swallow = "export async function f(engine: any) { try { return (await engine.executeRaw('select mode'))[0]; } catch (err) { console.warn(err); return { mode: 'git' }; } }";
    expect(scan(swallow)).toEqual(['src/x.ts#f capability_refusal_swallowed 1']);
    // Rethrowing the refusal first passes this rule.
    expect(scan(swallow.replace('console.warn(err);', 'rethrowCapabilityRefusal(err);'))).toEqual([]);
    // Each rule has its own opt-out: the empty-answer marker does not exempt this rule, its own marker does.
    expect(scan(swallow.replace('catch (err) {', 'catch (err) { // silent-read-ok: fallback is right\n'))).toEqual(['src/x.ts#f capability_refusal_swallowed 1']);
    expect(scan(swallow.replace('catch (err) {', 'catch (err) { // capability-refusal-ok: fallback is right on every engine\n'))).toEqual([]);
    // Engine implementation files are out of scope.
    expect(scan(swallow, 'src/core/postgres-engine.ts')).toEqual([]);
  });

  test('the rise message names each rule\'s fix, once per distinct fix', () => {
    const msg = riseFix(SILENT_READ_RULES);
    expect(msg).toContain('catch_empty / promise_catch_empty: return a typed degraded marker');
    expect(msg).toContain('capability_refusal_swallowed: let the refusal through');
    expect(msg).toContain('capability-refusal-ok: <reason>');
  });

  test('a new rule is one list entry: "a catch around an engine call must call rethrowCapabilityRefusal" is expressible', () => {
    const calls = (n: ts.Node, name: string): boolean => {
      let hit = false;
      const visit = (x: ts.Node): void => {
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === name) hit = true;
        ts.forEachChild(x, visit);
      };
      visit(n);
      return hit;
    };
    const rule: SilentReadRule = {
      name: 'engine-catch-rethrows-refusal',
      metric: 'catch_no_rethrow',
      okMarker: 'rethrow-ok',
      matcher: site => site.kind === 'try-catch' && isReadShaped(site) && !site.handlerStatements.some(s => calls(s, 'rethrowCapabilityRefusal')),
    };
    const src = [
      'export async function a(engine: any) { try { return await engine.getPage("a"); } catch (e) { return [1]; } }',
      'export async function b(engine: any) { try { return await engine.getPage("a"); } catch (e) { rethrowCapabilityRefusal(e); return [1]; } }',
      'export async function c(engine: any) { try { return await engine.getPage("a"); } catch (e) { return [1]; } } // rethrow-ok: c',
    ].join('\n');
    const withRule = [...scanFile(src, 'src/x.ts', [...SILENT_READ_RULES, rule]).counts].map(([k, n]) => `${k.replace('\t', ' ')} ${n}`).sort();
    expect(withRule).toEqual(['src/x.ts#a catch_no_rethrow 1']);
  });
});

describe('named audit sites (code copied verbatim from master, docs/research/gbrain-behavior-audit.md)', () => {
  const counts = () => scanTree(join(REPO, 'test', 'fixtures', 'silent-read-catches', 'audit-sites')).counts;
  const expectSites: Array<[string, string, string, number]> = [
    // RET-02: the supersession lookup (a returned local Map after rethrowCapabilityRefusal)
    ['RET-02', 'src/core/search/hybrid.ts#readSupersededBy', 'catch_empty', 1],
    // contract-01: entity arm-2 lookup, the alias arm and the hydrate step
    ['contract-01', 'src/core/verbs/entity-card.ts#selectEntityCandidates', 'catch_empty', 3],
    // contract-02 and memory-13: card edge / fact / timeline / backlink reads (and the aka read)
    ['contract-02', 'src/core/verbs/entity-card.ts#assembleCard', 'promise_catch_empty', 6],
    ['memory-13', 'src/core/verbs/entity-card.ts#readAka', 'promise_catch_empty', 1],
    // memory-13: the founder-scorecard takes catch
    ['memory-13', 'src/commands/founder-scorecard.ts#runFounder', 'catch_empty', 1],
    // health-5: the doctor checks that answer status ok "Skipped (...)", and search_mode
    ['health-5', 'src/commands/doctor/checks/content-quality.ts#runContentSanity', 'catch_empty', 2],
    ['health-5', 'src/commands/doctor/checks/content-quality.ts#runQuarantine', 'catch_empty', 2],
    ['health-5', 'src/commands/doctor/checks/calibration.ts#checkLinkResolutionOpportunity', 'catch_empty', 1],
    ['health-5', 'src/commands/doctor/checks/consolidation-cycle.ts#checkPoolBudget', 'catch_empty', 1],
    ['health-5', 'src/commands/doctor/checks/queue-jobs.ts#computeWedgedQueueCheck', 'catch_empty', 1],
    ['health-5', 'src/commands/doctor/checks/queue-jobs.ts#computeAutopilotFanoutConcurrencyCheck', 'catch_empty', 1],
    ['health-5', 'src/commands/doctor/checks/local-audits.ts#runExtractionBacklogs', 'catch_empty', 1],
    ['health-5 search_mode', 'src/commands/doctor/checks/search-eval.ts#checkSearchMode', 'catch_empty', 1],
    // contract-10 and pages-13: trust lookups
    ['contract-10 / pages-13', 'src/core/ops/get-page-projection.ts#pageTrustForRead', 'promise_catch_empty', 1],
    ['contract-10', 'src/core/ops/search.ts#evidenceOutput<anon@1>', 'promise_catch_empty', 1],
    // fixed on rust-engine/doctor-checks-2, still on master: held-chunk count and core notices
    ['embed-backfill readBudgetLimited', 'src/core/minions/handlers/embed-backfill.ts#makeEmbedBackfillHandler>embedBackfillHandler', 'promise_catch_empty', 1],
    ['core-memory pendingCoreNotices', 'src/core/core-memory.ts#pendingCoreNotices', 'catch_empty', 1],
    // backup coverage catches
    ['backup coverage', 'src/core/backup/coverage.ts#computeBackupCoverage', 'catch_empty', 3],
    ['backup coverage', 'src/core/backup/coverage.ts#computeBackupCoverage', 'promise_catch_empty', 1],
    ['backup coverage', 'src/core/backup/coverage.ts#countLivePages', 'catch_empty', 1],
    ['backup coverage', 'src/core/backup/coverage.ts#brainMaturity', 'catch_empty', 1],
  ];
  for (const [id, key, metric, min] of expectSites) {
    test(`${id}: ${key} ${metric}`, () => {
      expect(counts().get(key + '\t' + metric) ?? 0).toBeGreaterThanOrEqual(min);
    });
  }

  test('known unsupported shapes stay uncounted: a read behind a helper handed the engine, with no read-verb name', () => {
    // src/core/held-embedding.ts budgetLimitedField and src/core/ops/pages.ts fenceHoldEntries (header of the guard)
    const heldEmbedding = 'export async function budgetLimitedField(engine: any, sourceId: string) { try { const found = await budgetLimitedReport(engine, { sourceId }); return found ? { budget_limited: found.report } : {}; } catch { return {}; } }';
    const pages = 'export async function h(ctx: any, page: any) { return (await fenceHoldEntries(ctx.engine, [page.source_id], { slug: page.slug }).catch(() => [])); }';
    expect(scan(heldEmbedding)).toEqual([]);
    expect(scan(pages)).toEqual([]);
  });
});
