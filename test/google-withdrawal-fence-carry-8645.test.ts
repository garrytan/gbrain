import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrainEngine } from '../src/core/engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, replaceOrInsertFactsFence } from '../src/core/facts-fence.ts';
import { replaceableFile, type StoredBody } from '../src/core/facts/file-body-guard.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

const sourceId = 'google-example';
const slug = 'calendar/event-example';
const providerPage = `---
title: Calendar entry
type: event
google_event_id: event-example
---
# Calendar entry

Provider-rendered description.
`;
const rawFence = `## Facts

${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Keeps a studio | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
${FACTS_FENCE_END}
`;
const overlaidFence = rawFence.replace(
  '| 1 | Keeps a studio | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |',
  '| 1 | ~~Keeps a studio~~ | fact | 1.0 | world | medium | 2026-01-01 | 2026-02-01 | chat | forgotten: requested |',
);

function addRawStoredFence(fileBytes: string, stored?: StoredBody): string | null {
  const body = stored?.compiled_truth ?? '';
  const start = body.indexOf(FACTS_FENCE_BEGIN);
  const end = start === -1 ? -1 : body.indexOf(FACTS_FENCE_END, start + FACTS_FENCE_BEGIN.length);
  if (end === -1) return null;
  return replaceOrInsertFactsFence(fileBytes, body.slice(start, end + FACTS_FENCE_END.length));
}

test('Google fence carry compares its missing checkout fence with raw storage and still guards edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-google-fence-8645-'));
  try {
    const filePath = join(root, 'event-example.md');
    writeFileSync(filePath, providerPage);
    const parsedRaw = parseMarkdown(`${providerPage.trimEnd()}\n\n${rawFence}`, `${slug}.md`);
    const parsedOverlay = parseMarkdown(`${providerPage.trimEnd()}\n\n${overlaidFence}`, `${slug}.md`);
    expect(parsedOverlay.compiled_truth).not.toBe(parsedRaw.compiled_truth);
    expect(parseFactsFence(parsedRaw.compiled_truth).facts[0]?.active).toBe(true);
    expect(parseFactsFence(parsedOverlay.compiled_truth).facts[0]?.active).toBe(false);

    const state = {
      ...parsedRaw,
      compiled_truth: parsedRaw.compiled_truth,
      timeline: parsedRaw.timeline ?? '',
      frontmatter: parsedRaw.frontmatter,
      tags: parsedRaw.tags,
    };
    const engine = { executeRaw: async () => [state] } as unknown as BrainEngine;

    const replaceable = await replaceableFile(engine, sourceId, slug, filePath, addRawStoredFence);
    expect(replaceable.ok).toBe(true);
    if (replaceable.ok) expect(replaceable.expectedFileBytes).toBe(providerPage);

    const edited = `${providerPage}\nFILE-ONLY-EDIT: keep this paragraph.\n`;
    writeFileSync(filePath, edited);
    const protectedEdit = await replaceableFile(engine, sourceId, slug, filePath, addRawStoredFence);
    expect(protectedEdit.ok).toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe(edited);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
