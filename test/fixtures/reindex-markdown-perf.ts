import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';

const root = process.env.REINDEX_FIXTURE_ROOT!;
const checkout = process.env.REINDEX_FIXTURE_CHECKOUT!;
const mode = process.env.REINDEX_FIXTURE_MODE!;
if (!root || !checkout || !['seed', 'inspect', 'reset', 'trace'].includes(mode)) {
  throw new Error('This fixture requires its isolated benchmark launcher');
}
globalThis.fetch = (() => {
  appendFileSync(join(root, 'network-attempts.log'), 'forbidden fetch\n');
  throw new Error('Network is forbidden in the reindex fixture');
}) as unknown as typeof fetch;
const { PGLiteEngine } = await import(join(checkout, 'src/core/pglite-engine.ts'));
const { MARKDOWN_CHUNKER_VERSION } = await import(join(checkout, 'src/core/chunkers/recursive.ts'));

if (mode === 'trace') {
  const transaction = PGLiteEngine.prototype.transaction;
  const trace = process.env.REINDEX_FIXTURE_TRACE!;
  let count = 0;
  let pageCount = 0;
  PGLiteEngine.prototype.transaction = async function<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    if ((this as unknown as { _pageTransaction: boolean })._pageTransaction) return transaction.call(this, fn);
    const id = ++count;
    const started = performance.now();
    let bodyDone = started;
    const pageKeys = new Set<string>();
    let statistics = false;
    let kind: 'page' | 'statistics' | 'other' = 'other';
    let pageSequence: number | undefined;
    appendFileSync(trace, JSON.stringify({ phase: 'begin', id, ms: started }) + '\n');
    const result = await transaction.call(this, async (tx: BrainEngine) => {
      const lockPageKeys = tx.lockPageKeys;
      tx.lockPageKeys = async function(this: BrainEngine, keys) {
        for (const key of keys) pageKeys.add(JSON.stringify([key.sourceId, key.slug]));
        await lockPageKeys.call(this, keys);
      };
      const executeRaw = tx.executeRaw;
      tx.executeRaw = async function<R = Record<string, unknown>>(this: BrainEngine, ...args: Parameters<BrainEngine['executeRaw']>): Promise<R[]> {
        if (args[0].trim().toUpperCase().startsWith('ANALYZE ')) statistics = true;
        return await executeRaw.apply(this, args) as R[];
      };
      const result = await fn(tx);
      bodyDone = performance.now();
      kind = pageKeys.size > 0 ? 'page' : statistics ? 'statistics' : 'other';
      if (kind === 'page') pageSequence = ++pageCount;
      appendFileSync(trace, JSON.stringify({ phase: 'body_done', id, ms: bodyDone, kind, pageSequence, pageKeys: [...pageKeys] }) + '\n');
      if (pageSequence === Number(process.env.REINDEX_FIXTURE_KILL_AT)) process.kill(process.pid, 'SIGKILL');
      return result;
    });
    appendFileSync(trace, JSON.stringify({ phase: 'committed', id, kind, pageSequence, pageKeys: [...pageKeys], bodyMs: bodyDone - started, commitMs: performance.now() - bodyDone }) + '\n');
    return result;
  };
} else {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: join(root, 'home/.gbrain/brain.pglite') });
  try {
    if (mode === 'seed') {
      await engine.initSchema();
      const pages = Number(process.env.REINDEX_FIXTURE_PAGES);
      const paragraphs = Number(process.env.REINDEX_FIXTURE_PARAGRAPHS);
      mkdirSync(join(root, 'notes'), { recursive: true });
      for (let start = 0; start < pages; start += 100) {
        await engine.transaction(async (tx: BrainEngine) => {
          for (let i = start; i < Math.min(pages, start + 100); i++) {
            const slug = `note-${String(i).padStart(5, '0')}`;
            const body = `# Synthetic note ${i}\n\n` + Array.from({ length: paragraphs }, (_, p) =>
              `## Section ${p}\n\nSynthetic record ${i} section ${p}. ` +
              'The example system stores a bounded queue of generic records. A worker checks the revision before committing a replacement. '.repeat(4),
            ).join('\n\n');
            const sourcePath = i % 2 === 0 ? `${slug}.md` : null;
            if (sourcePath) writeFileSync(join(root, 'notes', sourcePath), `---\ntitle: Synthetic note ${i}\ntype: note\ntags: [synthetic]\n---\n${body}\n`);
            await tx.executeRaw(
              `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, chunker_version, source_path)
               VALUES ($1, 'note', $2, $3, 'markdown', $4, $5)`,
              [slug, `Synthetic note ${i}`, body, MARKDOWN_CHUNKER_VERSION - 1, sourcePath],
            );
          }
        });
      }
      await engine.executeRaw(`INSERT INTO tags (page_id, tag) SELECT id, 'synthetic' FROM pages`);
      await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
        SELECT id, 0, 'Legacy synthetic chunk', 'compiled_truth' FROM pages`);
    } else if (mode === 'reset') {
      await engine.executeRaw('UPDATE pages SET chunker_version = $1', [MARKDOWN_CHUNKER_VERSION - 1]);
    }
    const counts = await engine.executeRaw(`SELECT COUNT(*)::integer AS pages,
      COUNT(*) FILTER (WHERE chunker_version < $1)::integer AS pending,
      COUNT(*) FILTER (WHERE chunker_version >= $1 AND NOT EXISTS
        (SELECT 1 FROM content_chunks c WHERE c.page_id = pages.id))::integer AS current_without_chunks,
      COUNT(*) FILTER (WHERE chunker_version >= $1 AND
        text_projection_revision IS DISTINCT FROM knowledge_revision)::integer AS current_without_projection,
      COUNT(*) FILTER (WHERE NOT EXISTS
        (SELECT 1 FROM tags t WHERE t.page_id = pages.id AND t.tag = 'synthetic'))::integer AS missing_tags
      FROM pages`, [MARKDOWN_CHUNKER_VERSION]);
    console.log(JSON.stringify(counts[0]));
  } finally {
    await engine.disconnect();
  }
}
