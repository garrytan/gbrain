import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';

/**
 * The canonical projection mirrors the body's fences into the takes and facts
 * tables, deleting or expiring rows the body no longer holds. Readers skip a
 * fence inside a code block, so without a guard a real fence wrapped in one
 * would silently drop its rows.
 */
let engine: PGLiteEngine;
let ctx: OperationContext;
const root = mkdtempSync(join(tmpdir(), 'gbrain-fence-projection-'));
const sourceId = 'fence-projection-test';

const takes = (claim: string) => renderTakesFence([{ rowNum: 1, claim, kind: 'take', holder: 'world', weight: 0.7, active: true }]);
const facts = (claim: string) => renderFactsTable([{ rowNum: 1, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }]);
const fences = (take: string, fact: string) => `## Takes\n\n${takes(take)}\n\n## Facts\n\n${facts(fact)}\n`;
const example = `\`\`\`\`markdown\n${takes('Doc example belief')}\n${facts('Doc example fact')}\n\`\`\`\`\n`;

async function put(slug: string, body: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  return submitPageMutation(ctx, { operation: 'put_page', params: {
    request_id: randomUUID(), slug, content: `---\ntype: note\ntitle: ${slug}\n---\n${body}`,
    ...(snapshot ? { expected_revision: snapshot.revision } : {}),
  } });
}

async function rows(slug: string) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const [t] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int n FROM takes WHERE page_id=$1', [snapshot.page.id]);
  const [f] = await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL', [sourceId, slug]);
  return { takes: t!.n, facts: f!.n };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  ctx = { engine, config: { engine: 'pglite' }, sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

test('wrapping a real fence in a code block is refused instead of dropping its rows', async () => {
  await put('wrapped', `Intro\n\n${fences('Example belief', 'Example fact')}`);
  expect(await rows('wrapped')).toEqual({ takes: 1, facts: 1 });
  await expect(put('wrapped', `Intro\n\n\`\`\`\n${fences('Example belief', 'Example fact')}\`\`\`\n`)).rejects.toThrow('inside a code block');
  expect(await rows('wrapped')).toEqual({ takes: 1, facts: 1 });
});

test('a stray fence before the real fence keeps its rows', async () => {
  const shapes = [
    (f: string) => `Intro\n\n\`\`\`\nstray never closed\n\n${f}`,
    (f: string) => `Intro\n\n\`\`\`\nstray\n\n${f}\n\`\`\`\ncode\n\`\`\`\n`,
    (f: string) => `Intro\n\n\`\`\`\nstray\n\n${f}\n\`\`\`ts\ncode\n\`\`\`\n`,
  ];
  for (const [i, shape] of shapes.entries()) {
    const slug = `stray-${i}`;
    await put(slug, `Intro\n\n${fences('Example belief', 'Example fact')}`);
    await put(slug, shape(fences('Example belief', 'Example fact')));
    expect(await rows(slug)).toEqual({ takes: 1, facts: 1 });
  }
});

test('a code example beside the real fence does not block ordinary writes', async () => {
  await put('example-only', example);
  expect(await rows('example-only')).toEqual({ takes: 0, facts: 0 });

  await put('edited', `${example}\n${fences('Example belief', 'Example fact')}`);
  await put('edited', `${example}\n${fences('Edited belief', 'Edited fact')}`);
  expect(await rows('edited')).toEqual({ takes: 1, facts: 1 });

  await put('deleted', `${example}\n${fences('Example belief', 'Example fact')}`);
  await put('deleted', example);
  expect(await rows('deleted')).toEqual({ takes: 0, facts: 0 });
});
