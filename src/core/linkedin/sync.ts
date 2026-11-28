/**
 * Whitelist-gated LinkedIn sync and verbatim post importer for gbrain's BrainEngine.
 */
import path from 'node:path';
import type { BrainEngine } from '../engine.ts';
import {
  collectorAddLink,
  collectorAddTimelineEntry,
  collectorPutPage,
} from '../collectors/publish.ts';
import { slugifyContactName } from '../whatsapp/whitelist.ts';
import {
  parseLinkedInConnections,
  parseLinkedInMessages,
  parseLinkedInShares,
} from './parser.ts';
import {
  renderLinkedInPostsPages,
  renderLinkedInSeedPersonPage,
  renderLinkedInSourcePage,
} from './render.ts';
import type { LinkedInPostsResult, LinkedInSyncItem, LinkedInSyncResult } from './types.ts';
import { defaultLinkedInExportDir, loadLinkedInWhitelist } from './whitelist.ts';

export async function syncLinkedInWhitelisted(
  engine: BrainEngine,
  opts: {
    sourceId?: string;
    exportDir?: string;
    whitelistPath?: string;
    dryRun?: boolean;
  } = {},
): Promise<LinkedInSyncResult> {
  const sourceId = opts.sourceId || 'default';
  const exportDir = path.resolve(opts.exportDir ?? defaultLinkedInExportDir());
  const dryRun = opts.dryRun ?? false;
  const wl = loadLinkedInWhitelist(opts.whitelistPath);

  const connections = parseLinkedInConnections(exportDir);
  const connByKey = new Map(connections.map((c) => [c.key, c]));
  const { ownerName, byContact } = parseLinkedInMessages(exportDir);

  const synced: LinkedInSyncItem[] = [];
  const skipped: Array<{ key: string; name: string; reason: string }> = [];

  for (const contact of wl.contacts) {
    const profile = connByKey.get(contact.key);
    let msgs = byContact.get(contact.key) ?? [];
    if (msgs.length === 0) {
      const targetSlug = slugifyContactName(contact.name);
      for (const list of byContact.values()) {
        if (list[0] && slugifyContactName(list[0].other_name) === targetSlug) {
          msgs = list;
          break;
        }
      }
    }

    if (!profile && msgs.length === 0) {
      skipped.push({ key: contact.key, name: contact.name, reason: 'not_found_in_export' });
      continue;
    }

    const rendered = renderLinkedInSourcePage({
      contact,
      profile,
      messages: msgs,
      ownerLabel: ownerName || 'Me',
    });
    const personSlug = `people/${contact.slug}`;

    if (dryRun) {
      const existingPerson = await engine.getPage(personSlug, { sourceId });
      const existingSource = await engine.getPage(rendered.slug, { sourceId });
      const sameFp = existingSource?.frontmatter?.fingerprint === rendered.fingerprint;
      synced.push({
        key: contact.key,
        name: contact.name,
        slug: contact.slug,
        messages: msgs.length,
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
        sourceKind: 'linkedin',
        sourceUri: `linkedin:${contact.key}`,
        ingestedVia: 'collector:linkedin',
      });
      sourceSkipped = putRes.skipped;
    }

    let personCreated = false;
    const existingPerson = await engine.getPage(personSlug, { sourceId });
    if (!existingPerson) {
      const seedMd = renderLinkedInSeedPersonPage({
        contact,
        profile,
        sourceSlug: rendered.slug,
        date: rendered.date,
        messageCount: msgs.length,
      });
      await collectorPutPage(engine, {
        sourceId,
        slug: personSlug,
        content: seedMd,
        sourceKind: 'linkedin',
        sourceUri: `linkedin:person:${contact.slug}`,
        ingestedVia: 'collector:linkedin',
      });
      personCreated = true;
    }

    const roleBit =
      profile?.position && profile?.company
        ? ` (${profile.position} at ${profile.company})`
        : '';
    const timelineAdded = unchangedSource
      ? false
      : await collectorAddTimelineEntry(engine, {
          sourceId,
          slug: personSlug,
          date: rendered.date,
          source: rendered.slug,
          summary: `LinkedIn sync captured profile${roleBit} and ${msgs.length} DM(s)`,
        });

    if (!unchangedSource || personCreated) {
      await collectorAddLink(engine, {
        sourceId,
        from: personSlug,
        to: rendered.slug,
        context: `LinkedIn profile & DMs (${msgs.length} messages)`,
        linkSource: 'linkedin-collector',
      });
    }

    synced.push({
      key: contact.key,
      name: contact.name,
      slug: contact.slug,
      messages: msgs.length,
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

export async function importLinkedInPosts(
  engine: BrainEngine,
  opts: {
    sourceId?: string;
    exportDir?: string;
    dryRun?: boolean;
  } = {},
): Promise<LinkedInPostsResult> {
  const sourceId = opts.sourceId || 'default';
  const exportDir = path.resolve(opts.exportDir ?? defaultLinkedInExportDir());
  const dryRun = opts.dryRun ?? false;
  const posts = parseLinkedInShares(exportDir);

  if (posts.length === 0) {
    return {
      ok: false,
      dry_run: dryRun,
      source_id: sourceId,
      post_count: 0,
      source_slug: '',
      original_slug: 'originals/linkedin-posts',
      skipped: true,
    };
  }

  const rendered = renderLinkedInPostsPages(posts);
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      source_id: sourceId,
      post_count: posts.length,
      source_slug: rendered.sourceSlug,
      original_slug: rendered.originalSlug,
      skipped: false,
    };
  }

  const srcRes = await collectorPutPage(engine, {
    sourceId,
    slug: rendered.sourceSlug,
    content: rendered.sourceMarkdown,
    sourceKind: 'linkedin_posts',
    sourceUri: `linkedin:shares:${posts.length}`,
    ingestedVia: 'collector:linkedin',
  });

  await collectorPutPage(engine, {
    sourceId,
    slug: rendered.originalSlug,
    content: rendered.originalMarkdown,
    sourceKind: 'linkedin_posts',
    sourceUri: 'linkedin:originals:shares',
    ingestedVia: 'collector:linkedin',
  });

  await collectorAddLink(engine, {
    sourceId,
    from: rendered.originalSlug,
    to: rendered.sourceSlug,
    context: `Verbatim LinkedIn posts (${posts.length} posts)`,
    linkSource: 'linkedin-collector',
  });

  return {
    ok: true,
    dry_run: false,
    source_id: sourceId,
    post_count: posts.length,
    source_slug: rendered.sourceSlug,
    original_slug: rendered.originalSlug,
    skipped: srcRes.skipped,
  };
}
