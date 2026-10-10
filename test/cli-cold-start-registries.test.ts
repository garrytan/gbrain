/**
 * Load-time registries under per-op loading (GBRA-75 wave 11).
 *
 * The CLI loads only the module behind the op it runs, so modules that
 * src/core/operations.ts used to load as a side effect may be absent, and
 * any module-level register*() / install*() call in them has not run. Every
 * such call site is classified below by why its registry cannot be observed
 * incomplete; a new call site fails here until it is classified.
 *
 * - self: the registry and its only reader live in the registering module.
 * - owns-queue: a background-work drainer registered by the module that owns
 *   the queue it drains, so anything that enqueues has loaded it.
 * - reader-loads: the reader imports the registering modules at the read point.
 * - cli-only: registered or read only by CLI-only command modules, which never
 *   run through the per-op loader.
 * - no-consumer: persistence/service.ts registers the config reader of the
 *   consumer it alone can start; without it there is no consumer to read.
 * - entry: process wiring in the CLI entry and the manifest-backed route table.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import { OPERATION_LOADERS } from '../src/core/operation-loaders.generated.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

type Kind = 'self' | 'owns-queue' | 'reader-loads' | 'cli-only' | 'no-consumer' | 'entry';
const REGISTRATIONS: Record<string, Kind> = {
  'src/cli.ts': 'entry',
  'src/cli/main.ts': 'entry',
  'src/cli/op-manifest.ts': 'entry',
  'src/core/operations.ts': 'entry',
  'src/commands/claw-test.ts': 'cli-only',
  'src/commands/decide/eval-lane.ts': 'cli-only',
  'src/commands/decide/writepath.ts': 'cli-only',
  'src/core/ai/decide/answerable.ts': 'cli-only',
  'src/core/ai/decide/dataset.ts': 'cli-only',
  'src/core/ai/decide/injection.ts': 'cli-only',
  'src/core/ai/decide/intent.ts': 'cli-only',
  'src/core/ai/decide/recall-needed.ts': 'cli-only',
  'src/core/ai/decide/runtime.ts': 'owns-queue',
  'src/core/ai/decide/store.ts': 'owns-queue',
  'src/core/context/volunteer-events.ts': 'owns-queue',
  'src/core/eval-capture.ts': 'owns-queue',
  'src/core/facts/queue.ts': 'owns-queue',
  'src/core/feedback/record.ts': 'owns-queue',
  'src/core/last-retrieved.ts': 'owns-queue',
  'src/core/search/hybrid.ts': 'owns-queue',
  'src/core/search/telemetry.ts': 'owns-queue',
  'src/core/ai/gateway.ts': 'self',
  'src/core/backfill-registry.ts': 'self',
  'src/core/search/decide-stage.ts': 'self',
  'src/core/persistence/service.ts': 'no-consumer',
  'src/core/trust/page-handlers.ts': 'reader-loads',
  'src/core/trust/supersede-handlers.ts': 'reader-loads',
};

/** Files with a register*()/install*() call outside any function or class body. */
function scanRegistrations(): string[] {
  const files = [...new Bun.Glob('src/**/*.ts').scanSync(REPO_ROOT)].sort();
  const found = new Set<string>();
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(resolve(REPO_ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (/^(register|install)[A-Z]/.test(name)) found.add(file);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return [...found].sort();
}

async function loadedModules(code: string): Promise<string[]> {
  const proc = Bun.spawn([process.execPath, '-e', `${code}\nconsole.log(JSON.stringify(Object.keys(require.cache)));`], {
    cwd: REPO_ROOT, env: { ...process.env, GBRAIN_HOME: '/nonexistent-gbrain-home' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code_] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code_ !== 0) throw new Error(err);
  const prefix = `${REPO_ROOT}/`;
  return (JSON.parse(out.trim().split('\n').pop()!) as string[]).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
}

describe('load-time registries under per-op loading', () => {
  test('every module-level register*/install* call site is classified', () => {
    expect(scanRegistrations()).toEqual(Object.keys(REGISTRATIONS).sort());
  });

  test('every op loaded alone misses only registrations that cannot be observed incomplete', async () => {
    const registering = new Set(Object.keys(REGISTRATIONS));
    const full = (await loadedModules("await import('./src/core/operations.ts');")).filter(f => registering.has(f));
    const names = Object.keys(OPERATION_LOADERS);
    const missing = new Map<string, Set<string>>();
    for (let i = 0; i < names.length; i += 8) {
      await Promise.all(names.slice(i, i + 8).map(async (name) => {
        const got = new Set(await loadedModules(`await (await import('./src/core/operation-load.ts')).loadOperation(${JSON.stringify(name)});`));
        for (const file of full) if (!got.has(file)) missing.set(file, (missing.get(file) ?? new Set()).add(name));
      }));
    }
    // operations.ts registers the op fix routes the CLI already registers from
    // the manifest (src/cli/op-manifest.ts, same ops: test/operation-manifest.test.ts).
    const unclassified = [...missing.keys()].filter(file => REGISTRATIONS[file] === 'entry' && file !== 'src/core/operations.ts');
    expect(unclassified).toEqual([]);
    expect([...missing.keys()].every(file => REGISTRATIONS[file] !== undefined)).toBe(true);
  }, 120_000);

  test('a trust decision sees every proposal handler without the full registry loaded', async () => {
    const probe = (prelude: string) => {
      const out = Bun.spawnSync([process.execPath, '-e', `${prelude}\nconst m = await import('./src/core/trust/proposals.ts');\nconsole.log(JSON.stringify((await m.ensureTrustProposalHandlers()).sort()));`], {
        cwd: REPO_ROOT, env: { ...process.env, GBRAIN_HOME: '/nonexistent-gbrain-home' },
      });
      if (out.exitCode !== 0) throw new Error(out.stderr.toString());
      return JSON.parse(out.stdout.toString().trim().split('\n').pop()!) as string[];
    };
    const alone = probe('');
    expect(alone).toEqual(probe("await import('./src/core/operations.ts');"));
    expect(alone).toEqual(['forget', 'lower_page', 'supersede_fact', 'supersede_take']);
  });
});
