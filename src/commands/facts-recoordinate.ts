/**
 * `gbrain facts-recoordinate` — single-record provenance re-coordinate operator.
 *
 * Moves ONE existing live orphan fact (row_num IS NULL) onto ONE appended fence
 * row on its canonical page, preserving the fact id and creating zero new facts,
 * behind a durable phase-aware crash boundary (see core/facts/recoordinate.ts).
 *
 *   gbrain facts-recoordinate <fact_id>            Dry preview (revalidate; no mutation)
 *   gbrain facts-recoordinate <fact_id> --apply    Execute the re-coordinate
 *   gbrain facts-recoordinate --status [<fact_id>] List pending durable markers
 *   gbrain facts-recoordinate --recover [<fact_id>]Fail-forward recovery
 *   [--json]
 *
 * Single-record only; no bulk loop. Default is a dry preview.
 */
import { execFileSync } from 'node:child_process';
import { relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { revalidate, recoordinateFact, listPendingMarkers, recoverPending, type Durability } from '../core/facts/recoordinate.ts';
import { isDurabilityHardened, commitWriteThroughFile } from '../core/brain-repo-durability.ts';

function hasFlag(args: string[], f: string): boolean { return args.includes(f); }
function positional(args: string[]): string | undefined { return args.find(a => !a.startsWith('-')); }
function git(writeRoot: string, gitArgs: string[]): string {
  return execFileSync('git', ['-C', writeRoot, ...gitArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A branch ref safe to place in `refs/heads/<ref>` and to push. Fail closed on
 *  detached HEAD (`git rev-parse --abbrev-ref HEAD` returns the literal `HEAD`)
 *  and on any empty/whitespace/odd ref, so we NEVER create or push a branch
 *  literally named `HEAD` (round-4 hardening). */
function assertBranchRef(ref: string): string {
  if (!ref || ref === 'HEAD' || /\s/.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new Error(`refusing to push: not on a valid named branch (ref=${JSON.stringify(ref)}); detached HEAD is not durable`);
  }
  return ref;
}

/** The target's path RELATIVE to the write root, guaranteed contained (no `..`,
 *  not absolute) so the remote `git show origin/<ref>:<relpath>` cannot escape
 *  the tree (round-4 hardening). Returns null when containment cannot be proven. */
function containedRelPath(writeRoot: string, filePath: string): string | null {
  const rel = relative(writeRoot, filePath);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || rel.split(sep).includes('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/'); // git uses forward slashes
}

/** Git-backed durability with SYNCHRONOUS push proof (298#1). The shipped
 *  `commitWriteThroughFile` is best-effort (commit now, background post-commit
 *  push), so it cannot be treated as confirmed durability. This helper commits
 *  the working-tree change (if any), then performs a SYNCHRONOUS `git push` and
 *  verifies HEAD is on a remote branch before returning — so a returned commitId
 *  is provably published. `commitAndPush` never throws on "nothing to commit"
 *  (it pushes the existing HEAD), making recovery idempotent across the commit
 *  boundary; it throws only if the push cannot be confirmed durable. */
function gitDurability(): Durability {
  return {
    isHardened: (writeRoot) => isDurabilityHardened(writeRoot),
    commitAndPush: async (filePath, writeRoot, slug) => {
      const ref = assertBranchRef(git(writeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])); // fail closed on detached HEAD
      git(writeRoot, ['add', '--', filePath]);
      // 305#4: PATH-SCOPED cached-diff — unrelated staged files must not force a
      // commit when the target has no change (that would break idempotent recovery).
      let targetStaged = false;
      try { git(writeRoot, ['diff', '--cached', '--quiet', '--', filePath]); } catch { targetStaged = true; }
      if (targetStaged) { if (!commitWriteThroughFile(writeRoot, filePath, slug)) throw new Error('durable commit failed'); }
      git(writeRoot, ['push', 'origin', `HEAD:refs/heads/${ref}`]); // SYNCHRONOUS push to the tracked branch
      return { commitId: git(writeRoot, ['rev-parse', 'HEAD']), ref };
    },
    currentRemoteFileHash: async (writeRoot, ref, filePath) => {
      try {
        assertBranchRef(ref);
        const rel = containedRelPath(writeRoot, filePath); // path containment for the remote show
        if (rel == null) return null;
        git(writeRoot, ['fetch', '--quiet', 'origin', ref]); // bounded fetch of the current remote tip
        const content = execFileSync('git', ['-C', writeRoot, 'show', `origin/${ref}:${rel}`], { encoding: 'utf8' });
        return createHash('sha256').update(content).digest('hex');
      } catch { return null; }
    },
  };
}

export async function runFactsRecoordinate(engine: BrainEngine, args: string[]): Promise<void> {
  const json = hasFlag(args, '--json');
  const emit = (o: unknown) => { if (json) console.log(JSON.stringify(o, null, 2)); };

  if (hasFlag(args, '--status')) {
    const rows = await listPendingMarkers(engine, positional(args));
    if (json) emit({ pending: rows });
    else {
      console.log(`Pending re-coordination markers: ${rows.length}`);
      for (const r of rows) console.log(`  marker ${r.id} → fact ${r.fact_id} @ ${r.source_id}:${r.slug}#${r.row_num} [status=${r.status} phase=${r.phase}]`);
    }
    return;
  }

  if (hasFlag(args, '--recover')) {
    const out = await recoverPending(engine, { durability: gitDurability(), factId: positional(args) });
    if (json) emit({ recovered: out });
    else { console.log(`Recovery processed ${out.length} pending marker(s):`); for (const o of out) console.log(`  marker ${o.marker_id} (phase=${o.phase}): ${o.outcome}`); }
    return;
  }

  const factId = positional(args);
  if (!factId) { console.error('Usage: gbrain facts-recoordinate <fact_id> [--apply] | --status [<id>] | --recover [<id>] [--json]'); process.exit(1); }

  if (!hasFlag(args, '--apply')) {
    const r = await revalidate(engine, factId);
    if (json) emit({ dry_run: true, fact_id: factId, ok: r.ok, reason: r.reason,
      target: r.ctx ? { source_id: r.ctx.source_id, slug: r.ctx.slug, preimage_fence_sha256: r.ctx.preimage_fence_sha256 } : null });
    else if (r.ok && r.ctx) console.log(`DRY: fact ${factId} is re-coordinatable onto ${r.ctx.source_id}:${r.ctx.slug} (run with --apply). No mutation performed.`);
    else console.log(`DRY: fact ${factId} FAILS revalidation: ${r.reason}. No mutation performed.`);
    return;
  }

  const res = await recoordinateFact(engine, factId, { durability: gitDurability() });
  if (json) emit(res);
  else if (res.ok) console.log(`Re-coordinated fact ${res.fact_id} → row ${res.proposed_row_num} (${res.coordinate_outcome}). Marker ${res.marker_id}.`);
  else { console.error(`Re-coordinate failed for fact ${res.fact_id}: ${res.reason} (phase=${res.phase}, outcome=${res.coordinate_outcome ?? 'n/a'})`); process.exit(1); }
}
