/**
 * Wave C 1D (§4.6, C3): a Git LFS pointer committed where a page belongs. Committed-mode sync reads blobs with
 * `cat-file` and `GIT_LFS_SKIP_SMUDGE=1`, and a checkout without git-lfs never smudges, so an LFS-tracked Markdown file
 * reaches the sync freeze as its ~130-byte pointer text. Imported, that text would replace the page. The freeze holds it
 * `lfs_pointer_unsmudged` instead (committed and working mode alike), so a pointer is never imported and never replaces
 * a stored page.
 *
 * The fix changes how the file is stored from then on (out of LFS, as a plain Git blob), so it is the user's call
 * (`ask_user`): an ordered plan that ends with the real bytes and a `.gitattributes` override committed through
 * `gbrain git commit-push`. Who writes the checkout (`LfsWriter`, recorded on the hold) picks the branch: a plain
 * `checkout` commits and pushes; a `managed` canonical worktree only commits the named paths and its owner publishes
 * them (put_page cannot replace a page whose file is held); a `hosted` repository refuses pushes and has no working
 * tree of the user's, so the real bytes come from the user's own clone and are committed in gbrain's hosted worktree.
 * Every branch ends with the same verify.
 */
import type { Action } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';
import { isImageFilePath } from '../sync.ts';
import { managedFilesystemRootFor } from './filesystem-guard.ts';

export type LfsWriter = 'checkout' | 'managed' | 'hosted';
export const LFS_POINTER_DOCS = 'docs/guides/write-refusals.md#lfs_pointer_unsmudged';
export const LFS_POINTER_MAX_BYTES = 1024;

/** The object id and size of a Git LFS pointer blob (LF line endings), or null. Kept here, away from the sync reader, so cold reads that import the hold fix stay small. */
export function lfsPointer(blob: Buffer): { oid: string; size: number } | null {
  const text = blob.toString('utf8');
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1\n') || !text.endsWith('\n')) return null;
  const fields = new Map(text.slice(0, -1).split('\n').map(line => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)] as const));
  const oid = /^sha256:([0-9a-f]{64})$/.exec(fields.get('oid') ?? '')?.[1];
  const size = fields.get('size') ?? '';
  return oid && /^\d+$/.test(size) ? { oid, size: Number(size) } : null;
}

/** The `lfs_pointer_unsmudged` refusal of a page file whose text is a Git LFS pointer (version line, `oid sha256:`, `size`), or null. */
export function lfsPointerRefusal(path: string, content: string): { code: 'lfs_pointer_unsmudged'; message: string } | null {
  if (isImageFilePath(path) || Buffer.byteLength(content, 'utf8') > LFS_POINTER_MAX_BYTES) return null;
  const pointer = lfsPointer(Buffer.from(content.replace(/\r\n/g, '\n'), 'utf8'));
  if (!pointer) return null;
  return { code: 'lfs_pointer_unsmudged', message: `${path} is a Git LFS pointer (sha256 ${pointer.oid.slice(0, 12)}…, ${pointer.size} bytes), not the page's text: `
    + 'the bytes sync reads were never smudged, so sync held this file, the stored page stays as it was and the rest of the source kept syncing. '
    + 'Store the file without LFS (the hold\'s fix lists the steps), then sync again.' };
}

/** Who writes the source's checkout: a hosted repository (`config.hosted_repo`), a managed canonical worktree, or a plain checkout. */
export function lfsWriterFor(root: string, config: Record<string, unknown> | null): LfsWriter {
  if (config?.hosted_repo) return 'hosted';
  return managedFilesystemRootFor(root) ? 'managed' : 'checkout';
}

/** POSIX single-quoting: a held path comes from the repository, so the plan never lets the shell expand it. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The ordered fix of an `lfs_pointer_unsmudged` hold for its writer: a read-only first step, the plan in `user_message`. The
 * plan appends an anchored `-filter -diff -merge` override for the one path to `.gitattributes` instead of
 * `git lfs untrack`, which removes only an exact rule and leaves a file under `*.md` or `notes/**` in LFS.
 */
export function lfsPointerHoldFix(record: { source_id: string; path: string; meta: { lfs_writer?: LfsWriter } }): Action {
  const { source_id: source, path } = record;
  const file = shellQuote(path);
  const pattern = shellQuote(`/${path.replace(/[*?[\]\\!#"]/g, c => `\\${c}`).replace(/\s/g, '[[:space:]]')}`);
  const leaveLfs = `printf '%s -filter -diff -merge\\n' ${pattern} >> .gitattributes, then git add --renormalize -- ${file} .gitattributes (git check-attr filter -- ${file} must say unset)`;
  const commit = `gbrain git commit-push -m ${shellQuote(`Store ${path} without LFS`)} -- ${file} .gitattributes`;
  const checkoutSteps = `(1) in the source's checkout root, run git lfs version and install git-lfs if it fails; (2) git lfs pull --include ${file} so the working tree has the real bytes; `
    + `(3) ${leaveLfs}; `;
  const steps: Record<LfsWriter, string> = {
    checkout: checkoutSteps + `(4) ${commit} (never a plain git commit in a shared checkout).`,
    managed: checkoutSteps + `(4) ${commit}: in a managed canonical worktree it commits only those paths and the owner publishes them (put_page cannot replace a page whose file is held).`,
    hosted: `(1) in your own clone of the hosted repository, run git lfs version (install git-lfs if it fails) and git lfs pull --include ${file} to get the real bytes; `
      + `(2) on the brain host, copy them over the pointer at ${file} in the source's hosted worktree root, then ${leaveLfs} there; `
      + `(3) ${commit} in that worktree: it commits under gbrain's writer lock, and the hosted repository refuses pushes, so this is how the file changes.`,
  };
  const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
  return { argv: ['gbrain', 'sources', 'status', source, '--json'], consent: [], actor: 'user', requires_exclusive: false, docs: LFS_POINTER_DOCS,
    user_message: `${path} in source ${source} is committed as a Git LFS pointer, so sync holds it and the stored page stays as it was; the rest of the source keeps syncing. `
      + `Storing it without LFS changes how the file is kept from now on, so ask first. With the user's agreement: ${steps[record.meta.lfs_writer ?? 'checkout']} Then run gbrain sync --source ${source} --no-pull.`,
    why: 'A pointer is never imported: its text would replace the page, and re-indexing from Git needs the real bytes, which a skip-smudge read never gives. The hold re-screens when the file changes.',
    then: { argv: ['gbrain', 'sync', '--source', source, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `Re-imports ${path} once its real bytes are committed; the hold clears when the screen reads them.` },
    verify };
}

/** Doctor `lfs_page_pointers`: per source, how many files are held as unsmudged LFS pointers, and the first paths. */
export async function readLfsPointerHolds(engine: Pick<BrainEngine, 'executeRaw'>, sample: number): Promise<Array<{ source_id: string; held: number; paths: string[] }>> {
  const rows = await engine.executeRaw<{ source_id: string; path: string }>(`SELECT s.id AS source_id, h.completed_keys->0->>'path' AS path
    FROM op_checkpoints h JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op='sync-hold' AND h.completed_keys->0->>'code'='lfs_pointer_unsmudged' ORDER BY s.id, path`);
  const out = new Map<string, { source_id: string; held: number; paths: string[] }>();
  for (const row of rows) {
    const entry = out.get(row.source_id) ?? { source_id: row.source_id, held: 0, paths: [] };
    entry.held++;
    if (entry.paths.length < sample) entry.paths.push(row.path);
    out.set(row.source_id, entry);
  }
  return [...out.values()];
}
