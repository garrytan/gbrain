// #6545: a remote put_page that restores privacy-hidden fact rows stored a
// body ending in "\n" (the fence insert appends one after parsing), while
// the canonical file it wrote reparses trimmed. The DB row then never
// matched its own file, so every later coordinated write on the page was
// refused `source_changed` until the next sync reimported it.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown } from '../src/core/markdown.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { preserveProtectedTakes } from '../src/core/persistence/protected-takes.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const SLUG = 'projects/x';
const PRIVATE_FENCE = `# X

Body.

## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Secret claim | fact | 1.0 | private | low | | | test | |
${FACTS_FENCE_END}
`;

const op = (name: string) => operations.find(o => o.name === name)!;

async function put(ctx: OperationContext, content: string) {
  const current = await ctx.engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  return op('put_page').handler(ctx, { slug: SLUG, content, ...(current ? { expected_revision: current.revision } : {}) });
}

test('#6545 remote put_page restoring a hidden fact row stores the parse-normal body and later writes succeed', async () => {
  await managedBrain(async ({ engine, ctx, root }) => {
    await put(ctx, `---\ntype: project\ntitle: X\n---\n\n${PRIVATE_FENCE}`);
    const remote = { ...ctx, remote: true } as OperationContext;
    await put(remote, `---\ntype: project\ntitle: X\n---\n\n# X\n\nBody edited.\n\n<!-- timeline -->\n\n## Timeline\n\n- **2026-10-12** | s — e\n`);

    const page = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(parseFactsFence(page!.compiled_truth).facts.map(f => f.claim)).toEqual(['Secret claim']);
    const file = parseMarkdown(readFileSync(join(root, `${SLUG}.md`), 'utf8'), `${SLUG}.md`);
    await op('add_timeline_entry').handler(remote, { slug: SLUG, date: '2026-10-13', summary: 'follow-up' });
    const after = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(after!.timeline).toContain('follow-up');
    expect(page!.compiled_truth).toBe(file.compiled_truth);
    expect(page!.timeline).toBe(file.timeline);
  });
}, 60_000);

test('#6545 preserveProtectedTakes returns trimEnd-normal output', () => {
  const next = '# X\n\nBody.';
  const current = `# X\n\n<!--- gbrain:takes:begin -->\n| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|\n| 1 | t | take | people/a | 0.5 | 2026-01 | s |\n<!--- gbrain:takes:end -->\n`;
  const out = preserveProtectedTakes(next, current);
  expect(out).toBe(out.trimEnd());
});
