/**
 * `gbrain whatsapp`: whitelist-gated macOS WhatsApp Desktop personal CRM collector.
 *
 * Privacy contract:
 * - Zero pages are created for any contact until explicitly added to the whitelist.
 * - ChatStorage.sqlite is opened strictly read-only.
 * - Every ingested page is `visibility: private` with `source_kind: whatsapp`.
 */
import type { BrainEngine } from '../core/engine.ts';
import { listWhatsAppCandidates } from '../core/whatsapp/reader.ts';
import { syncWhatsAppWhitelisted } from '../core/whatsapp/sync.ts';
import {
  addWhatsAppWhitelistEntry,
  importWhatsAppWhitelistFile,
  loadWhatsAppWhitelist,
  removeWhatsAppWhitelistEntry,
} from '../core/whatsapp/whitelist.ts';

const HELP = [
  'Usage:',
  '  gbrain whatsapp list [--search <q>] [--include-groups] [--limit <n>] [--db <path>] [--whitelist <path>] [--json]',
  '  gbrain whatsapp whitelist list [--whitelist <path>] [--json]',
  '  gbrain whatsapp whitelist add <jid> --name "<Name>" [--slug <slug>] [--category <cat>] [--whitelist <path>] [--json]',
  '  gbrain whatsapp whitelist remove <jid> [--whitelist <path>] [--json]',
  '  gbrain whatsapp whitelist import <json-file> [--whitelist <path>] [--json]',
  '  gbrain whatsapp sync [--source <id>] [--max-messages <n>] [--owner "<Name>"] [--db <path>] [--whitelist <path>] [--dry-run] [--json]',
  '',
  'Privacy: zero pages are created until a contact is explicitly whitelisted.',
].join('\n');

function flagValue(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export async function runWhatsApp(engine: BrainEngine, args: string[]): Promise<void> {
  const asJson = args.includes('--json');
  const [sub, action] = args;

  if (!sub || sub === '--help' || sub === '-h' || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const dbPath = flagValue(args, '--db');
  const whitelistPath = flagValue(args, '--whitelist');

  if (sub === 'list') {
    const res = listWhatsAppCandidates({
      dbPath,
      whitelistPath,
      search: flagValue(args, '--search'),
      includeGroups: args.includes('--include-groups'),
      limit: Number(flagValue(args, '--limit') ?? 50),
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(
      `WhatsApp candidates: ${res.total_matched} matched (${res.whitelisted_count} whitelisted) — ${res.db_path}`,
    );
    for (const c of res.candidates) {
      const mark = c.whitelisted ? '[WHITELISTED]' : '[ ]';
      console.log(
        `  ${mark} ${c.name} (${c.jid}) — ${c.message_count} msgs, last ${c.last_message || 'n/a'}`,
      );
    }
    return;
  }

  if (sub === 'whitelist') {
    if (!action || action === 'list') {
      const wl = loadWhatsAppWhitelist(whitelistPath);
      if (asJson) {
        console.log(JSON.stringify(wl, null, 2));
        return;
      }
      if (wl.contacts.length === 0) {
        console.log('WhatsApp whitelist is empty. Add a contact with: gbrain whatsapp whitelist add <jid> --name "<Name>"');
        return;
      }
      console.log(`WhatsApp whitelist (${wl.contacts.length} contacts):`);
      for (const c of wl.contacts) {
        console.log(`  - ${c.name} (${c.jid}) -> people/${c.slug} [${c.category}]`);
      }
      return;
    }

    if (action === 'add') {
      const jid = args[2];
      const name = flagValue(args, '--name');
      if (!jid || jid.startsWith('-') || !name) {
        throw new Error('Usage: gbrain whatsapp whitelist add <jid> --name "<Name>" [--slug <slug>] [--category <cat>]');
      }
      const entry = addWhatsAppWhitelistEntry({
        jid,
        name,
        slug: flagValue(args, '--slug'),
        category: flagValue(args, '--category'),
        whitelistPath,
      });
      console.log(asJson ? JSON.stringify(entry, null, 2) : `Whitelisted ${entry.name} (${entry.jid}) -> people/${entry.slug}`);
      return;
    }

    if (action === 'remove') {
      const jid = args[2];
      if (!jid || jid.startsWith('-')) {
        throw new Error('Usage: gbrain whatsapp whitelist remove <jid>');
      }
      const res = removeWhatsAppWhitelistEntry({ jid, whitelistPath });
      console.log(asJson ? JSON.stringify(res, null, 2) : `Removed ${res.removed} entry for ${res.jid}`);
      return;
    }

    if (action === 'import') {
      const fromPath = args[2];
      if (!fromPath || fromPath.startsWith('-')) {
        throw new Error('Usage: gbrain whatsapp whitelist import <json-file>');
      }
      const res = importWhatsAppWhitelistFile({ fromPath, whitelistPath });
      console.log(asJson ? JSON.stringify(res, null, 2) : `Imported ${res.imported} new contact(s) (${res.total} total whitelisted)`);
      return;
    }

    throw new Error(`Unknown whitelist subcommand "${action}".\n\n${HELP}`);
  }

  if (sub === 'sync') {
    const sourceId = flagValue(args, '--source') ?? flagValue(args, '--source-id') ?? 'default';
    const maxMessages = Number(flagValue(args, '--max-messages') ?? 500);
    const res = await syncWhatsAppWhitelisted(engine, {
      sourceId,
      dbPath,
      whitelistPath,
      maxMessages,
      ownerLabel: flagValue(args, '--owner'),
      dryRun: args.includes('--dry-run'),
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const mode = res.dry_run ? '[DRY RUN] ' : '';
    console.log(
      `${mode}WhatsApp sync (source=${res.source_id}): ${res.synced.length} processed, ${res.skipped.length} skipped (${res.whitelisted_count} whitelisted)`,
    );
    for (const s of res.synced) {
      const status = s.skipped ? 'unchanged' : s.person_created ? 'created' : 'updated';
      console.log(`  - ${s.name}: ${s.messages} msgs -> ${s.source_slug} (${status}, dossier=${s.person_slug})`);
    }
    return;
  }

  throw new Error(`Unknown whatsapp subcommand "${sub}".\n\n${HELP}`);
}
