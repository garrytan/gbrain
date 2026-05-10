/**
 * `gbrain repair-default-source` — relocate pages misfiled in
 * `source_id='default'` due to the v0.18-v0.22 multi-source sync regression.
 *
 * Background: `importFromContent` did not thread sourceId to `tx.putPage`,
 * so every synced page silently landed in the default source. When the
 * same slug also existed at `(brain, slug)` (or any other source), the
 * mid-transaction state had two rows with matching slug, and the next
 * scalar subquery in the import path (e.g. addLink) exploded with
 * "more than one row returned by a subquery used as an expression".
 *
 * For each row currently in `source_id='default'` the command:
 *
 *   1. Looks up the slug across configured sources whose `local_path` holds
 *      a file matching `<local_path>/<slug>.md` (markdown) or the same path
 *      with a code-file extension (code page).
 *   2. If exactly one source has the file:
 *      - and `(source, slug)` does NOT already exist in `pages`:
 *        UPDATE the leaked row's `source_id` to that source.
 *      - and `(source, slug)` DOES exist: DELETE the leaked row.
 *   3. If multiple sources have the file: leave alone, log as ambiguous.
 *   4. If no source has the file: leave alone, log as orphan.
 *
 * Idempotent. Safe to re-run. Postgres + PGLite both supported.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, toEngineConfig } from '../core/config.ts';
import { createEngine } from '../core/engine-factory.ts';
import type { BrainEngine } from '../core/engine.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface SourceRow {
  id: string;
  local_path: string | null;
}

interface DefaultRow {
  id: number;
  slug: string;
  page_kind: string;
}

export interface RepairAction {
  slug: string;
  decision: 'moved' | 'deleted_duplicate' | 'ambiguous' | 'orphan';
  target_source?: string;
  candidate_sources?: string[];
}

export interface RepairResult {
  total_default_rows: number;
  moved: number;
  deleted_duplicate: number;
  ambiguous: number;
  orphan: number;
  actions: RepairAction[];
}

const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.php', '.scala', '.lua', '.sh',
  '.sql', '.css', '.scss', '.html',
];

function safeExists(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOwningSources(slug: string, pageKind: string, sources: SourceRow[]): string[] {
  const owners: string[] = [];
  for (const src of sources) {
    if (!src.local_path) continue;
    if (pageKind === 'code') {
      // Code slugs aren't guaranteed to round-trip 1:1 to paths; we don't
      // reverse the slugifier here. Try common code extensions.
      for (const ext of CODE_EXTENSIONS) {
        if (safeExists(join(src.local_path, slug + ext))) {
          owners.push(src.id);
          break;
        }
      }
      continue;
    }
    if (safeExists(join(src.local_path, slug + '.md'))) owners.push(src.id);
  }
  return owners;
}

export async function repairDefaultSource(
  engine: BrainEngine,
  opts: { dryRun?: boolean } = {},
): Promise<RepairResult> {
  const sources = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE id != 'default'`,
  );

  const defaults = await engine.executeRaw<DefaultRow>(
    `SELECT id, slug, page_kind FROM pages WHERE source_id = 'default' ORDER BY slug`,
  );

  const result: RepairResult = {
    total_default_rows: defaults.length,
    moved: 0,
    deleted_duplicate: 0,
    ambiguous: 0,
    orphan: 0,
    actions: [],
  };

  if (defaults.length === 0) return result;

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('repair_default_source.rows', defaults.length);

  for (const row of defaults) {
    const owners = findOwningSources(row.slug, row.page_kind, sources);

    if (owners.length === 0) {
      result.orphan++;
      result.actions.push({ slug: row.slug, decision: 'orphan' });
      progress.tick(1, `orphan:${row.slug}`);
      continue;
    }

    if (owners.length > 1) {
      result.ambiguous++;
      result.actions.push({
        slug: row.slug,
        decision: 'ambiguous',
        candidate_sources: owners,
      });
      progress.tick(1, `ambiguous:${row.slug}`);
      continue;
    }

    const target = owners[0]!;
    const existing = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE source_id = $1 AND slug = $2`,
      [target, row.slug],
    );

    if (existing.length > 0) {
      if (!opts.dryRun) {
        await engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [row.id]);
      }
      result.deleted_duplicate++;
      result.actions.push({
        slug: row.slug,
        decision: 'deleted_duplicate',
        target_source: target,
      });
      progress.tick(1, `deleted_dup:${row.slug}`);
    } else {
      if (!opts.dryRun) {
        await engine.executeRaw(
          `UPDATE pages SET source_id = $1, updated_at = now() WHERE id = $2`,
          [target, row.id],
        );
      }
      result.moved++;
      result.actions.push({
        slug: row.slug,
        decision: 'moved',
        target_source: target,
      });
      progress.tick(1, `moved:${row.slug}->${target}`);
    }
  }

  progress.finish();
  return result;
}

export async function runRepairDefaultSourceCli(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  const config = loadConfig();
  if (!config) {
    throw new Error('No brain configured. Run: gbrain init');
  }
  const engine = await createEngine(toEngineConfig(config));
  await engine.connect(toEngineConfig(config));

  try {
    const result = await repairDefaultSource(engine, { dryRun });

    if (jsonMode) {
      console.log(JSON.stringify({ status: 'ok', dry_run: dryRun, ...result }));
      return;
    }

    const verb = dryRun ? 'would' : 'did';
    console.log(`${dryRun ? '[dry-run] ' : ''}repair-default-source: scanned ${result.total_default_rows} row(s) in source_id='default'.`);
    console.log(`  ${verb} move:              ${result.moved} (matching file in exactly one source)`);
    console.log(`  ${verb} delete duplicate:  ${result.deleted_duplicate} (rightful row already exists)`);
    console.log(`  ambiguous (left alone): ${result.ambiguous} (file present in multiple sources)`);
    console.log(`  orphan    (left alone): ${result.orphan} (no source has the file)`);

    if (result.ambiguous > 0 || result.orphan > 0) {
      console.log('\nAmbiguous + orphan rows stay in source_id=default until you delete them or fix the source paths.');
    }
  } finally {
    await engine.disconnect();
  }
}
