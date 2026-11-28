/**
 * Whitelist-gated WhatsApp sync into gbrain's BrainEngine.
 *
 * Cardinal rules enforced:
 * 1. Only explicitly whitelisted contacts are read and ingested.
 * 2. Source pages (`source/whatsapp/...`) are written via `importFromContent`
 *    (full chunking, search sealing, tag indexing, and content-hash dedup).
 * 3. Living dossiers (`people/<slug>`) are NEVER overwritten if they already exist;
 *    instead, a dated timeline entry (`addTimelineEntry`) and typed `documented_by`
 *    edge (`addLink`) are appended.
 */
import type { BrainEngine } from '../engine.ts';
import {
  collectorAddLink,
  collectorAddTimelineEntry,
  collectorPutPage,
} from '../collectors/publish.ts';
import { readWhatsAppMessages } from './reader.ts';
import { renderWhatsAppSeedPersonPage, renderWhatsAppSourcePage } from './render.ts';
import type { WhatsAppSyncItem, WhatsAppSyncResult } from './types.ts';
import { loadWhatsAppWhitelist } from './whitelist.ts';

export async function syncWhatsAppWhitelisted(
  engine: BrainEngine,
  opts: {
    sourceId?: string;
    dbPath?: string;
    whitelistPath?: string;
    maxMessages?: number;
    ownerLabel?: string;
    dryRun?: boolean;
  } = {},
): Promise<WhatsAppSyncResult> {
  const sourceId = opts.sourceId || 'default';
  const dryRun = opts.dryRun ?? false;
  const wl = loadWhatsAppWhitelist(opts.whitelistPath);

  const synced: WhatsAppSyncItem[] = [];
  const skipped: Array<{ jid: string; name: string; reason: string }> = [];

  for (const contact of wl.contacts) {
    const messages = readWhatsAppMessages({
      jid: contact.jid,
      dbPath: opts.dbPath,
      maxMessages: opts.maxMessages ?? 500,
    });
    if (messages.length === 0) {
      skipped.push({ jid: contact.jid, name: contact.name, reason: 'no_text_messages' });
      continue;
    }

    const rendered = renderWhatsAppSourcePage({
      contact,
      messages,
      ownerLabel: opts.ownerLabel,
    });
    const personSlug = `people/${contact.slug}`;

    if (dryRun) {
      const existingPerson = await engine.getPage(personSlug, { sourceId });
      const existingSource = await engine.getPage(rendered.slug, { sourceId });
      const sameFp = existingSource?.frontmatter?.fingerprint === rendered.fingerprint;
      synced.push({
        jid: contact.jid,
        name: contact.name,
        slug: contact.slug,
        messages: messages.length,
        source_slug: rendered.slug,
        person_slug: personSlug,
        person_created: existingPerson === null,
        timeline_added: !sameFp,
        skipped: sameFp,
      });
      continue;
    }

    const existingSource = await engine.getPage(rendered.slug, { sourceId });
    const unchangedSource = existingSource?.frontmatter?.fingerprint === rendered.fingerprint;
    let sourceSkipped = unchangedSource;
    if (!unchangedSource) {
      const putRes = await collectorPutPage(engine, {
        sourceId,
        slug: rendered.slug,
        content: rendered.markdown,
        sourceKind: 'whatsapp',
        sourceUri: `whatsapp:${contact.jid}`,
        ingestedVia: 'collector:whatsapp',
      });
      sourceSkipped = putRes.skipped;
    }

    let personCreated = false;
    const existingPerson = await engine.getPage(personSlug, { sourceId });
    if (!existingPerson) {
      const seedMd = renderWhatsAppSeedPersonPage({
        contact,
        sourceSlug: rendered.slug,
        date: rendered.date,
        messageCount: messages.length,
      });
      await collectorPutPage(engine, {
        sourceId,
        slug: personSlug,
        content: seedMd,
        sourceKind: 'whatsapp',
        sourceUri: `whatsapp:person:${contact.slug}`,
        ingestedVia: 'collector:whatsapp',
      });
      personCreated = true;
    }

    const timelineAdded = unchangedSource
      ? false
      : await collectorAddTimelineEntry(engine, {
          sourceId,
          slug: personSlug,
          date: rendered.date,
          source: rendered.slug,
          summary: `WhatsApp sync captured ${messages.length} text messages through ${rendered.date}`,
        });

    if (!unchangedSource || personCreated) {
      await collectorAddLink(engine, {
        sourceId,
        from: personSlug,
        to: rendered.slug,
        context: `WhatsApp transcript (${messages.length} messages through ${rendered.date})`,
        linkSource: 'whatsapp-collector',
      });
    }

    synced.push({
      jid: contact.jid,
      name: contact.name,
      slug: contact.slug,
      messages: messages.length,
      source_slug: rendered.slug,
      person_slug: personSlug,
      person_created: personCreated,
      timeline_added: timelineAdded,
      skipped: sourceSkipped,
    });
  }

  return {
    dry_run: dryRun,
    source_id: sourceId,
    whitelisted_count: wl.contacts.length,
    synced,
    skipped,
  };
}
