import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';
import type { BrainEngine } from '../../core/engine';
import type { WorkbenchConversation, WorkbenchMessage } from '../../../shared/workbench';
import { importFromContent } from '../../core/import-file';
import { serializePageToMarkdown } from '../../core/markdown';
import { getConfiguredEmbeddingModel } from '../../core/ai/gateway';
import { prepareLinkReconciliation } from '../../core/link-reconciliation';
import { replaceDerivedLinks } from '../../core/derived-links';
import { lockRelationPages, readRelationSnapshot } from '../../core/pmbrain-adapters/relation-writer';
import { retireInvalidMemoryTakes } from '../../core/pmbrain-adapters/memory-projections';
import { WorkbenchStore } from './store';

type ProjectionFact = { id: number; fact: string; entity_slug: string | null; current: boolean; valid_until: Date | null; visibility: string };
export function memoryArchiveBody(conversationId: string, messageId: string, hash: string, facts: Pick<ProjectionFact, 'fact' | 'entity_slug'>[]): string {
  return `[对话出处](pmbrain://conversations/${conversationId}/${messageId}?hash=${hash})\n\n${facts.map(row => `- ${row.fact}${row.entity_slug ? ` [[${row.entity_slug}]]` : ''}`).join('\n')}\n`;
}

export async function refreshWorkbenchMemoryArchives(engine: BrainEngine, store: WorkbenchStore, conversations = store.list(), sourceId?: string): Promise<void> {
  for (const conversation of conversations) for (const message of conversation.messages) {
    if (!message.memory || message.memory.status !== 'complete' || !message.memory.factIds?.length || sourceId && message.memory.sourceId !== sourceId) continue;
    await refreshArchive(engine, store, conversation, message);
  }
  const sources = sourceId ? [sourceId] : [...new Set(conversations.flatMap(row => row.messages.flatMap(message => message.memory ? [message.memory.sourceId] : [])))];
  for (const source of sources) await retireInvalidMemoryTakes(engine, source);
}

async function refreshArchive(engine: BrainEngine, store: WorkbenchStore, conversation: WorkbenchConversation, message: WorkbenchMessage) {
  const memory = message.memory!;
  const sourceId = memory.sourceId;
  const archives = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND slug LIKE $3 AND frontmatter->>'pmbrain_memory'='true' AND frontmatter->>'id'=$2", [sourceId, `${message.id}-${memory.hash}`, `conversations/pmbrain/${conversation.id}/%`]);
  for (const archive of archives) {
    let changed = false;
    await engine.transaction(async tx => {
      await lockRelationPages(tx, [{ sourceId, slug: archive.slug }]);
      const live = store.get(conversation.id).messages.find(row => row.id===message.id && row.memory?.hash===memory.hash && row.memory.sourceId===sourceId && row.memory.status==='complete');
      if (!live) return;
      await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [sourceId, archive.slug]);
      const snapshot = await readRelationSnapshot(tx, archive.slug, sourceId);
      if (!snapshot || snapshot.page.deleted_at || snapshot.page.frontmatter.pmbrain_memory !== true || snapshot.page.frontmatter.id !== `${message.id}-${memory.hash}` || snapshot.page.frontmatter.source_ref !== `pmbrain://conversations/${conversation.id}/${message.id}`) return;
      const page = snapshot.page;
      const ids = Array.isArray(page.frontmatter.pmbrain_memory_fact_ids) ? page.frontmatter.pmbrain_memory_fact_ids.map(Number).filter(Number.isSafeInteger) : memory.factIds!;
      const rows = await tx.executeRaw<ProjectionFact>(`SELECT id, fact, entity_slug, valid_until, visibility,
        (expired_at IS NULL AND (valid_until IS NULL OR valid_until>now()) AND (visibility='world' OR $3='private')) AS current
        FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) ORDER BY array_position($2::bigint[],id) FOR SHARE`, [sourceId, ids, memory.visibility]);
      const generated = memoryArchiveBody(conversation.id, message.id, memory.hash, rows).trim().split('\n').sort().join('\n');
      if (rows.length !== ids.length || page.timeline.trim() || page.compiled_truth.trim().split('\n').sort().join('\n') !== generated) return;
      const current = rows.filter(row => row.current);
      if (current.length === rows.length && page.frontmatter.pmbrain_memory_origin && Array.isArray(page.frontmatter.pmbrain_memory_fact_ids)) return;
      if (!current.length) {
        await replaceDerivedLinks(tx, { slug: archive.slug, sourceId, expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation }, [], { includeFrontmatter: true, wanted: { producers: ['body', 'frontmatter'], rows: [] } });
        await tx.softDeletePage(archive.slug, { sourceId });
      } else {
        const frontmatter = { ...page.frontmatter, pmbrain_memory_fact_ids: current.map(row => Number(row.id)), pmbrain_memory_origin: { conversationId: conversation.id, messageId: message.id, hash: memory.hash } };
        const original = await tx.getPage(archive.slug, { sourceId, includeDeleted: true });
        if (!original) return;
        const content = serializePageToMarkdown({ ...original, frontmatter, compiled_truth: memoryArchiveBody(conversation.id, message.id, memory.hash, current) }, await tx.getTags(archive.slug, { sourceId }));
        await tx.putPage(archive.slug, { ...original, frontmatter }, { sourceId });
        const result = await importFromContent(tx, archive.slug, content, { sourceId, noEmbed: !getConfiguredEmbeddingModel(), forceRechunk: true });
        if (result.error) throw new Error(result.error);
      }
      changed = true;
    });
    if (changed) {
      if (await engine.getPage(archive.slug, { sourceId })) {
        const reconcile = await prepareLinkReconciliation(engine);
        await reconcile(archive.slug, sourceId, { includeFrontmatter: true });
      }
    }
  }
  const path = toNamespacedPath(join(store.root, 'memory', conversation.id, `${createHash('sha256').update(`${message.id}:${memory.hash}`).digest('hex')}.md`));
  if (!existsSync(path)) return;
  const rows = await engine.executeRaw<ProjectionFact>(`SELECT fact,entity_slug,valid_until,visibility,
    (expired_at IS NULL AND (valid_until IS NULL OR valid_until>now())) AS current
    FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) ORDER BY array_position($2::bigint[],id)`, [sourceId, memory.factIds]);
  const previous = readFileSync(path, 'utf8');
  const prefix = `# 对话记忆 ${memory.capturedAt}\n\n`;
  const claims = new Set(rows.map(row => `- ${row.fact}${row.entity_slug ? ` [[${row.entity_slug}]]` : ''}`));
  if (!previous.startsWith(prefix) || !previous.slice(prefix.length).trimEnd().split('\n').every(line => claims.has(line))) return;
  const current = rows.filter(row => row.current && row.visibility==='world' && row.valid_until===null);
  if (!current.length) unlinkSync(path);
  else {
    const content = `${prefix}${current.map(row => `- ${row.fact}${row.entity_slug ? ` [[${row.entity_slug}]]` : ''}`).join('\n')}\n`;
    if (content !== previous) { writeFileSync(`${path}.tmp`, content, { mode: 0o600 }); renameSync(`${path}.tmp`, path); }
  }
}
