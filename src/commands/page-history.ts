import type { BrainEngine } from '../core/engine.ts';
import type { PageVersion } from '../core/types.ts';

function parseDuration(input: string): Date {
  const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(input.trim());
  if (!m) throw new Error(`Invalid duration "${input}". Use e.g. 30d, 2h, 90m, 60s.`);
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const seconds = unit === 's' ? n
    : unit === 'm' ? n * 60
    : unit === 'h' ? n * 3600
    : unit === 'd' ? n * 86400
    : n * 7 * 86400;
  return new Date(Date.now() - seconds * 1000);
}

function diffArrays(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    added: b.filter(x => !sa.has(x)),
    removed: a.filter(x => !sb.has(x)),
  };
}

function diffObjects(a: Record<string, unknown>, b: Record<string, unknown>): {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
} {
  const added: Record<string, unknown> = {};
  const removed: Record<string, unknown> = {};
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(a)) {
    if (!(k in b)) removed[k] = a[k];
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed[k] = { from: a[k], to: b[k] };
  }
  for (const k of Object.keys(b)) {
    if (!(k in a)) added[k] = b[k];
  }
  return { added, removed, changed };
}

function unifiedDiff(from: string, to: string): string {
  const a = from.split('\n');
  const b = to.split('\n');
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;
    if (left !== undefined) out.push(`- ${left}`);
    if (right !== undefined) out.push(`+ ${right}`);
  }
  return out.join('\n');
}

function printVersions(slug: string, versions: PageVersion[], json: boolean) {
  if (json) {
    process.stdout.write(JSON.stringify(versions, null, 2) + '\n');
    return;
  }
  if (versions.length === 0) {
    process.stdout.write(`No history for ${slug}.\n`);
    return;
  }
  for (const v of versions) {
    const ts = v.snapshot_at instanceof Date ? v.snapshot_at.toISOString() : String(v.snapshot_at);
    const prov = v.provenance && (v.provenance as { source?: string }).source
      ? ` <${(v.provenance as { source?: string }).source}>`
      : '';
    process.stdout.write(`#${v.id}\t${ts}\t[${v.kind}]${prov}\t${v.compiled_truth.slice(0, 60).replace(/\n/g, ' ')}\n`);
  }
}

export async function runHistoryCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const includeOrphan = args.includes('--include-orphan');
  const positional = args.filter(a => !a.startsWith('--'));
  const sub = positional[0];

  if (sub === 'prune') {
    const slugIdx = args.indexOf('--slug');
    const slug = slugIdx >= 0 ? args[slugIdx + 1] : undefined;
    const keepIdx = args.indexOf('--keep-last');
    const keepLast = keepIdx >= 0 ? Number(args[keepIdx + 1]) : undefined;
    const olderIdx = args.indexOf('--older-than');
    const olderThan = olderIdx >= 0 ? parseDuration(args[olderIdx + 1]) : undefined;
    const dryRun = args.includes('--dry-run');

    if (keepLast === undefined && olderThan === undefined) {
      throw new Error('history prune requires --keep-last N or --older-than DUR.');
    }
    if (keepLast !== undefined && (!Number.isFinite(keepLast) || keepLast < 0)) {
      throw new Error('--keep-last must be a non-negative integer.');
    }
    if (keepLast !== undefined && !slug) {
      throw new Error('--keep-last requires --slug to scope the prune.');
    }

    if (dryRun) {
      const out = {
        dry_run: true,
        slug: slug ?? null,
        keep_last: keepLast,
        older_than: olderThan?.toISOString() ?? null,
        global_older_than: slug ? false : !!olderThan,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return;
    }
    const removed = await engine.prunePageVersions({ slug, keepLast, olderThan });
    process.stdout.write(json ? JSON.stringify({ removed }, null, 2) + '\n' : `Removed ${removed} version(s).\n`);
    return;
  }

  const slug = positional[0];
  if (!slug) {
    throw new Error('Usage: gbrain history <slug> [--include-orphan] [--diff <from> <to>] [--json]\n       gbrain history prune [--slug X] [--keep-last N | --older-than DUR] [--dry-run]');
  }

  const diffIdx = args.indexOf('--diff');
  if (diffIdx >= 0) {
    const fromV = Number(args[diffIdx + 1]);
    const toV = Number(args[diffIdx + 2]);
    if (!Number.isFinite(fromV) || !Number.isFinite(toV)) {
      throw new Error('--diff requires two numeric version ids: --diff <from> <to>');
    }
    const diff = await engine.diffPageVersions(slug, fromV, toV);
    if (json) {
      process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
      return;
    }
    process.stdout.write(`# diff ${slug} #${fromV} → #${toV}\n\n`);
    const ct = unifiedDiff(diff.compiled_truth.from, diff.compiled_truth.to);
    if (ct) {
      process.stdout.write('## compiled_truth\n');
      process.stdout.write(ct + '\n\n');
    } else {
      process.stdout.write('## compiled_truth: unchanged\n\n');
    }
    const fmDiff = diffObjects(diff.frontmatter.from, diff.frontmatter.to);
    if (Object.keys(fmDiff.added).length || Object.keys(fmDiff.removed).length || Object.keys(fmDiff.changed).length) {
      process.stdout.write('## frontmatter\n');
      for (const [k, v] of Object.entries(fmDiff.added)) process.stdout.write(`+ ${k}: ${JSON.stringify(v)}\n`);
      for (const [k, v] of Object.entries(fmDiff.removed)) process.stdout.write(`- ${k}: ${JSON.stringify(v)}\n`);
      for (const [k, v] of Object.entries(fmDiff.changed)) process.stdout.write(`~ ${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}\n`);
      process.stdout.write('\n');
    } else {
      process.stdout.write('## frontmatter: unchanged\n\n');
    }
    const tagDiff = diffArrays(diff.tags.from, diff.tags.to);
    if (tagDiff.added.length || tagDiff.removed.length) {
      process.stdout.write('## tags\n');
      for (const t of tagDiff.added) process.stdout.write(`+ ${t}\n`);
      for (const t of tagDiff.removed) process.stdout.write(`- ${t}\n`);
    } else {
      process.stdout.write('## tags: unchanged\n');
    }
    return;
  }

  const versions = await engine.getVersions(slug, { includeDeletedPage: includeOrphan });
  printVersions(slug, versions, json);
}

export async function runResurrectCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args.find(a => !a.startsWith('--'));
  const json = args.includes('--json');
  if (!slug) throw new Error('Usage: gbrain resurrect <slug>');
  const existing = await engine.getPage(slug, { includeDeleted: true });
  if (!existing) {
    throw new Error(`Page not found: ${slug}`);
  }
  if (!existing.deleted_at) {
    const out = { status: 'already_active', slug };
    process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n' : `Page ${slug} is already active.\n`);
    return;
  }
  await engine.resurrectSoftDeletedPage(slug);
  await engine.createVersion(slug, {
    kind: 'update',
    provenance: { source: 'cli_resurrect' },
  });
  const out = { status: 'resurrected', slug };
  process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n' : `Resurrected ${slug}.\n`);
}

export async function runPurgeCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const slug = args.find(a => !a.startsWith('--'));
  const json = args.includes('--json');
  const yes = args.includes('--yes') || args.includes('-y');
  if (!slug) throw new Error('Usage: gbrain purge <slug> --yes');
  if (!yes) {
    throw new Error(`Refusing to hard-delete ${slug} without --yes. Use \`gbrain delete <slug>\` for soft delete.`);
  }
  await engine.purgePage(slug);
  const out = { status: 'purged', slug };
  process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n' : `Purged ${slug} (history removed).\n`);
}

export async function runRevertCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith('--'));
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const slug = positional[0];
  const versionId = Number(positional[1]);
  if (!slug || !Number.isFinite(versionId)) {
    throw new Error('Usage: gbrain revert <slug> <version-id> [--dry-run] [--json]');
  }
  if (dryRun) {
    const out = { dry_run: true, slug, version_id: versionId };
    process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n' : `Would revert ${slug} to version #${versionId}.\n`);
    return;
  }
  await engine.revertToVersion(slug, versionId, {
    provenance: { source: 'cli_revert', target_version_id: versionId },
  });
  const hint = `Run \`gbrain extract --slugs ${slug} && gbrain embed --stale --slugs ${slug}\` to refresh derived state.`;
  const out = { status: 'reverted', slug, version_id: versionId, hint };
  process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n' : `Reverted ${slug} to version #${versionId}.\n${hint}\n`);
}
