/**
 * `gbrain secrets restore <id>` (GST-2988): puts a false positive back. Preview first: it lists every recorded
 * occurrence of the entry whose page still holds the marker, under a hash; `--apply --expect <hash>` replaces each
 * marker with the original in the stores redaction rewrote, page by page under the page's key lock, rebuilds the
 * search projection, and sets the entry to `allowed` so redactors leave the value alone from then on. Only recorded
 * occurrences are restored: a marker copied into another page stays as it is. Trusted local CLI only.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { previewChangedError } from '../persistence/preview-approval.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { withCoordinatedWrite, withTrustKeep, withWriteAttribution } from '../persistence/context.ts';
import { readManagedMode } from '../persistence/managed-mode.ts';
import { resealAfterRestore, restoreMarkersOnPage } from '../repair/secret-spans.ts';
import { entryRow, markerOf, occurrencesOf, openEntry, secretsAudit } from './store.ts';

export interface RestorePreview {
  id: string; rule: string; source_id: string; status: string; hash: string;
  pages: Array<{ slug: string; revision: string; fields: string[] }>;
  command: string;
}

const previewCommand = (id: string) => `gbrain secrets restore ${id}`;

/** The pages a restore would change: recorded occurrences whose live page still holds the marker. */
export async function previewRestore(engine: BrainEngine, id: string): Promise<RestorePreview> {
  const row = await entryRow(engine, id);
  openEntry(row);
  const marker = markerOf(row.rule, row.id);
  const occurrences = await occurrencesOf(engine, id);
  const slugs = [...new Set(occurrences.filter(o => o.slug && o.source_id === row.source_id).map(o => o.slug!))].sort();
  const pages: RestorePreview['pages'] = [];
  for (const slug of slugs) {
    const [page] = await engine.executeRaw<{ revision: string; hit: boolean }>(
      `SELECT knowledge_revision::text AS revision, (position($3 in coalesce(title,'') || coalesce(compiled_truth,'') || coalesce(timeline,'') || coalesce(frontmatter::text,'')) > 0
         OR body_storage = 'segmented') AS hit FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`, [row.source_id, slug, marker]);
    if (!page?.hit) continue;
    const fields = [...new Set(occurrences.filter(o => o.slug === slug).map(o => o.field))].sort();
    pages.push({ slug, revision: page.revision, fields });
  }
  const hash = createHash('sha256').update(JSON.stringify(['secrets-restore-v1', id, row.status, pages])).digest('hex').slice(0, 16);
  return { id, rule: row.rule, source_id: row.source_id, status: row.status, hash, pages, command: previewCommand(id) };
}

export interface RestoreResult { id: string; restored: Array<{ slug: string; markers: number; fields: string[] }>; skipped: Array<{ slug: string; reason: string }>; status: 'allowed' }

export async function applyRestore(engine: BrainEngine, id: string, expect: string, actor: string): Promise<RestoreResult> {
  const preview = await previewRestore(engine, id);
  if (preview.hash !== expect) throw previewChangedError(expect, preview.command);
  const row = await entryRow(engine, id);
  const originals = new Map([[markerOf(row.rule, row.id), openEntry(row)]]);
  const restored: RestoreResult['restored'] = [];
  const skipped: RestoreResult['skipped'] = [];
  for (const page of preview.pages) {
    const out = await engine.transaction(async tx => {
      const managed = await readManagedMode(tx, { refusal: { subject: 'secrets restore' } });
      const attribution = await maintenanceAttribution(tx);
      const write = () => withTrustKeep(tx, ['pages', 'facts', 'takes', 'timeline_entries'], async () => {
        const [live] = await tx.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [row.source_id, page.slug]);
        if (!live || live.revision !== page.revision) return 'changed_since_preview' as const;
        return restoreMarkersOnPage(tx, row.source_id, page.slug, originals);
      });
      return managed ? withCoordinatedWrite(tx, [row.source_id], write, attribution) : withWriteAttribution(tx, attribution, write);
    });
    if (typeof out === 'string') { skipped.push({ slug: page.slug, reason: out }); continue; }
    if (out.replaced) {
      await resealAfterRestore(engine, row.source_id, page.slug, out.storage, out.unsealed).catch(() => undefined);
      restored.push({ slug: page.slug, markers: out.replaced, fields: out.fields });
    }
  }
  if (skipped.length) {
    throw opError('preview_changed', `${skipped.length} page(s) changed since the preview (${skipped.map(s => s.slug).join(', ')}); ${restored.length} page(s) were restored and the entry stays active.`,
      `Re-run the preview: ${preview.command}`);
  }
  await engine.executeRaw("UPDATE secret_store SET status='allowed', updated_at=now() WHERE id=$1", [id]);
  await (await import('./spool.ts')).refreshAllowedCache(engine).catch(() => undefined);
  secretsAudit.log({ ts: new Date().toISOString(), event: 'restore', id, source_id: row.source_id, rule: row.rule, actor, slugs: restored.map(r => r.slug) });
  return { id, restored, skipped, status: 'allowed' };
}
