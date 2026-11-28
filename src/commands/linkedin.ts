/**
 * `gbrain linkedin`: whitelist-gated LinkedIn Data Export personal CRM collector.
 *
 * Privacy contract:
 * - Zero pages are created for any LinkedIn contact until explicitly whitelisted.
 * - Bulk raw CSV exports remain local under `<configDir>/collectors/linkedin-export/`.
 * - Contact source pages carry `visibility: private` and `source_kind: linkedin`.
 * - User's own published posts (`Shares.csv`) are imported verbatim into `originals/linkedin-posts`.
 */
import type { BrainEngine } from '../core/engine.ts';
import { listLinkedInCandidates, unpackLinkedInExport } from '../core/linkedin/parser.ts';
import { importLinkedInPosts, syncLinkedInWhitelisted } from '../core/linkedin/sync.ts';
import {
  addLinkedInWhitelistEntry,
  loadLinkedInWhitelist,
  removeLinkedInWhitelistEntry,
} from '../core/linkedin/whitelist.ts';

const HELP = [
  'Usage:',
  '  gbrain linkedin import-export <zip-or-dir> [--export-dir <dir>] [--json]',
  '  gbrain linkedin list [--search <q>] [--with-dms] [--limit <n>] [--export-dir <dir>] [--whitelist <path>] [--json]',
  '  gbrain linkedin whitelist list [--whitelist <path>] [--json]',
  '  gbrain linkedin whitelist add <key> --name "<Name>" [--url <url>] [--slug <slug>] [--category <cat>] [--whitelist <path>] [--json]',
  '  gbrain linkedin whitelist remove <key> [--whitelist <path>] [--json]',
  '  gbrain linkedin sync [--source <id>] [--export-dir <dir>] [--whitelist <path>] [--dry-run] [--json]',
  '  gbrain linkedin import-posts [--source <id>] [--export-dir <dir>] [--dry-run] [--json]',
  '',
  'Privacy: zero contact pages are created until a person is explicitly whitelisted.',
].join('\n');

function flagValue(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export async function runLinkedIn(engine: BrainEngine, args: string[]): Promise<void> {
  const asJson = args.includes('--json');
  const [sub, action] = args;

  if (!sub || sub === '--help' || sub === '-h' || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const exportDir = flagValue(args, '--export-dir');
  const whitelistPath = flagValue(args, '--whitelist');

  if (sub === 'import-export') {
    const inputPath = args[1];
    if (!inputPath || inputPath.startsWith('-')) {
      throw new Error('Usage: gbrain linkedin import-export <zip-or-dir> [--export-dir <dir>]');
    }
    const res = unpackLinkedInExport({ inputPath, exportDir });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    console.log(`Unpacked ${res.saved_files.length} file(s) into ${res.export_dir}: ${res.saved_files.join(', ')}`);
    return;
  }

  if (sub === 'list') {
    const res = listLinkedInCandidates({
      exportDir,
      whitelistPath,
      search: flagValue(args, '--search'),
      onlyWithDms: args.includes('--with-dms'),
      limit: Number(flagValue(args, '--limit') ?? 50),
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (!res.ready) {
      console.log(`No LinkedIn export found in ${res.export_dir}. Run: gbrain linkedin import-export <archive.zip>`);
      return;
    }
    console.log(
      `LinkedIn candidates: ${res.total_matched} matched (${res.total_connections} connections, ${res.whitelisted_count} whitelisted)`,
    );
    for (const c of res.candidates) {
      const mark = c.whitelisted ? '[WHITELISTED]' : '[ ]';
      const role = [c.position, c.company].filter(Boolean).join(' @ ');
      console.log(
        `  ${mark} ${c.name} (${c.key})${role ? ` — ${role}` : ''} | DMs=${c.message_count}${c.last_message ? `, last ${c.last_message}` : ''}`,
      );
    }
    return;
  }

  if (sub === 'whitelist') {
    if (!action || action === 'list') {
      const wl = loadLinkedInWhitelist(whitelistPath);
      if (asJson) {
        console.log(JSON.stringify(wl, null, 2));
        return;
      }
      if (wl.contacts.length === 0) {
        console.log('LinkedIn whitelist is empty. Add a contact with: gbrain linkedin whitelist add <key> --name "<Name>"');
        return;
      }
      console.log(`LinkedIn whitelist (${wl.contacts.length} contacts):`);
      for (const c of wl.contacts) {
        console.log(`  - ${c.name} (${c.key}) -> people/${c.slug} [${c.category}]`);
      }
      return;
    }

    if (action === 'add') {
      const key = args[2];
      const name = flagValue(args, '--name');
      if (!key || key.startsWith('-') || !name) {
        throw new Error('Usage: gbrain linkedin whitelist add <key> --name "<Name>" [--url <url>] [--slug <slug>] [--category <cat>]');
      }
      const entry = addLinkedInWhitelistEntry({
        key,
        name,
        url: flagValue(args, '--url'),
        slug: flagValue(args, '--slug'),
        category: flagValue(args, '--category'),
        whitelistPath,
      });
      console.log(asJson ? JSON.stringify(entry, null, 2) : `Whitelisted ${entry.name} (${entry.key}) -> people/${entry.slug}`);
      return;
    }

    if (action === 'remove') {
      const key = args[2];
      if (!key || key.startsWith('-')) {
        throw new Error('Usage: gbrain linkedin whitelist remove <key>');
      }
      const res = removeLinkedInWhitelistEntry({ key, whitelistPath });
      console.log(asJson ? JSON.stringify(res, null, 2) : `Removed ${res.removed} entry for ${res.key}`);
      return;
    }

    throw new Error(`Unknown whitelist subcommand "${action}".\n\n${HELP}`);
  }

  if (sub === 'sync') {
    const sourceId = flagValue(args, '--source') ?? flagValue(args, '--source-id') ?? 'default';
    const res = await syncLinkedInWhitelisted(engine, {
      sourceId,
      exportDir,
      whitelistPath,
      dryRun: args.includes('--dry-run'),
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const mode = res.dry_run ? '[DRY RUN] ' : '';
    console.log(
      `${mode}LinkedIn sync (source=${res.source_id}): ${res.synced.length} processed, ${res.skipped.length} skipped (${res.whitelisted_count} whitelisted)`,
    );
    for (const s of res.synced) {
      const status = s.skipped ? 'unchanged' : s.person_created ? 'created' : 'updated';
      console.log(`  - ${s.name}: ${s.messages} DMs -> ${s.source_slug} (${status}, dossier=${s.person_slug})`);
    }
    return;
  }

  if (sub === 'import-posts') {
    const sourceId = flagValue(args, '--source') ?? flagValue(args, '--source-id') ?? 'default';
    const res = await importLinkedInPosts(engine, {
      sourceId,
      exportDir,
      dryRun: args.includes('--dry-run'),
    });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (!res.ok) {
      console.log('No Shares.csv posts found in the LinkedIn export directory. Request the larger LinkedIn archive with Posts enabled.');
      return;
    }
    const mode = res.dry_run ? '[DRY RUN] ' : '';
    console.log(`${mode}Imported ${res.post_count} LinkedIn post(s) verbatim -> ${res.original_slug} (source=${res.source_slug})`);
    return;
  }

  throw new Error(`Unknown linkedin subcommand "${sub}".\n\n${HELP}`);
}
