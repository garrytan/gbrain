import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writeFactsToFence } from '../../src/core/facts/fence-write.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';

export const SLUG = 'people/alice-example';
export const CLAIM = 'Alice Example leads research';
export const EDIT = '\n\nAn independent edit that must survive.\n';

export async function withFactsBrain(databaseUrl: string | undefined, run: (b: FactsBrain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'facts-overwrite-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'brain');
        const file = join(root, `${SLUG}.md`);
        mkdirSync(dirname(file), { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example\n\nA person.\n' });
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
        writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
        const b: FactsBrain = {
          engine, root, file,
          bytes: () => readFileSync(file, 'utf8'),
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [SLUG]))[0]!.compiled_truth,
          async append(on = engine, claim = CLAIM) {
            return writeFactsToFence(on, { sourceId: 'default', localPath: root, slug: SLUG, resolutionSource: 'exact_page' },
              [{ fact: claim, kind: 'fact', notability: 'medium', source: 'test', visibility: 'world', embedding: null, sessionId: null }]);
          },
          async dbEdit() {
            await engine.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || $2 WHERE source_id = 'default' AND slug = $1", [SLUG, EDIT]);
          },
          fileEdit() { writeFileSync(file, readFileSync(file, 'utf8') + EDIT); },
        };
        await run(b);
      } finally { await close(); _resetWriteThroughCacheForTest(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

export interface FactsBrain {
  engine: BrainEngine;
  root: string;
  file: string;
  bytes(): string;
  body(): Promise<string>;
  append(on?: BrainEngine, claim?: string): ReturnType<typeof writeFactsToFence>;
  dbEdit(): Promise<void>;
  fileEdit(): void;
}

/** Land an edit after planning, immediately before the transaction that publishes the prepared fence. */
export function editWhenPrepared(b: FactsBrain, edit: () => Promise<void> | void, prepared = () => existsSync(`${b.file}.tmp`)): BrainEngine {
  let fired = false;
  return new Proxy(b.engine, { get(target, prop) {
    if (prop === 'transaction') return async (...args: unknown[]) => {
      if (!fired && prepared()) { fired = true; await edit(); }
      return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** An editor saves after the awaited database write, inside the real transaction, before the final rename. */
export function editAfterWrite(b: FactsBrain, method: 'insertFacts' | 'refreshPageBody', edit: () => void): BrainEngine {
  let fired = false;
  const wrap = (engine: BrainEngine): BrainEngine => new Proxy(engine, { get(target, prop) {
    if (prop === 'transaction') return <T>(run: (tx: BrainEngine) => Promise<T>, opts?: Parameters<BrainEngine['transaction']>[1]) =>
      target.transaction(tx => run(wrap(tx)), opts);
    if (prop === method) return async (...args: unknown[]) => {
      const result = await (target[method] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      if (!fired && existsSync(`${b.file}.tmp`)) { fired = true; edit(); }
      return result;
    };
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return wrap(b.engine);
}
