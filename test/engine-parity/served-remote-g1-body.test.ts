/**
 * BrainEngine parity: a remote search on a segmented page over the served wire: the body manifest (readBodyManifestRows,
 * readBodyManifestMeta) behind each evidence window, and the fence-row normalization (normalizeFenceLines) behind
 * the withdrawal overlay of the page's lead.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) a remote search (return_unit
 *    window and section) (MCP stdio, dispatchToolCall with remote: true) on a segmented page deliver the same
 *    evidence, struck of a withdrawn fence row; a segmented page the caller may not read (owner-private) is not delivered.
 *  - Regression: on the served arm each body read was refused for a remote caller (not on OWNER_IPC_REMOTE_TYPED_READS), so the
 *    evidence read failed with a typed engine_capability_missing refusal. (A remote get_page of a segmented page still needs
 *    readPageViewDigest and writePageViewDigest, and assemble_evidence resolveFrozenHits, which no lane serves; that is a separate gap.)
 *  - Why existing coverage misses it: chunk-page-segmented.test.ts and segmented-body.test.ts read a segmented page on the arm's own
 *    engine; no parity file ran the remote operation that sends the manifest reads over the served wire.
 *  - Seam: none. The page is imported with segmented storage on; the operation is the real one.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const stdio = () => ({ remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default', noticeLedger: new NoticeLedger() }) as never;
const FENCE = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Prefers the aisle seat | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | Walks to work | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const bodyOf = (word: string) => `# ${word}\n\n## Facts\n\n${FENCE}\n\n` + Array.from({ length: 12 }, (_, i) => `## Part ${i} of ${word}\n\n${`The ${word} section ${i} text about quillwort and heron. `.repeat(2400)}\n`).join('\n');

/** Import a page with segmented storage on, so its body is a manifest of segments. */
async function publish(engine: BrainEngine, slug: string, title: string, frontmatter: Record<string, unknown> = {}) {
  await engine.setConfig('pages.segmented_storage', 'on');
  const r = await importFromContent(engine, slug, serializeMarkdown(frontmatter, bodyOf(title), '', { type: 'note', title, tags: [] }), { sourceId: 'default', noEmbed: true });
  expect(r.status).toBe('imported');
}

const text = (out: { content: { text?: string }[] }) => out.content.map(c => c.text ?? '').join('\n').replace(/"revision":"[^"]*"/g, '"revision":"-"').replace(/gpw1\.[A-Za-z0-9_-]+/g, 'gpw1.-');

parityTest('a remote search delivers a segmented page\'s evidence windows, and none of a private page', {
  methods: ['readBodyManifestRows', 'readBodyManifestMeta', 'insertFactWithdrawal', 'normalizeFenceLines'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  await publish(engine, 'notes/body-open', 'Body open');
  await publish(engine, 'notes/body-private', 'Body private', { visibility: 'private' });
  await engine.insertFactWithdrawal('default', 'world', 'Walks to work', 'notes/body-open', '2026-03-01T10:00:00.000Z');
  const window = await dispatchToolCall(engine, 'search', { query: 'Body open quillwort heron', return_unit: 'window' }, stdio());
  expect(window.isError === true ? window.content[0]?.text?.slice(0, 400) : false).toBe(false);
  const section = await dispatchToolCall(engine, 'search', { query: 'Body open quillwort heron', return_unit: 'section' }, stdio());
  expect(section.isError === true ? section.content[0]?.text?.slice(0, 400) : false).toBe(false);
  expect(text(section)).toContain('quillwort');
  const hidden = await dispatchToolCall(engine, 'search', { query: 'Body private quillwort heron', return_unit: 'window' }, stdio());
  expect(text(hidden)).not.toContain('Body private');
  return { window: text(window), section: text(section), hidden: text(hidden) };
});
