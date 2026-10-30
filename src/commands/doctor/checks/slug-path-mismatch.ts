/**
 * #7305 `slug_path_mismatch`: live file-backed pages whose slug their recorded file path does not derive, such as a
 * hyphen run or a segment-final hyphen that the path rule folds (a slug with three hyphens between `notes/x-1900` and
 * `2000-ab`, recorded at that slug plus `.md`, imports as `notes/x-1900-2000-ab`). Import and sync keep such a page on its own slug only
 * through the `slug:` line its file carries (#5966); a file without that line imports as the derived slug and forks a
 * duplicate-origin twin (#6948), which sync then holds `origin_conflict`. put_page and capture refuse a new such slug;
 * this counts the pages that already exist.
 *
 * Read-only and bounded: one read of candidate rows (a slug pattern every non-derivable slug matches, in page id
 * order, at most SLUG_PATH_SCAN_LIMIT), then at most SLUG_PATH_FILE_LIMIT recorded files read on this host to tell a
 * stamped file from an unstamped one. Unstamped files warn and name `gbrain repair frontmatter --source <id>`, whose
 * preview proposes the stamp as a safe repair; a twin that already forked is `origin_twins`'s to report.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { boundUnknownDetails } from '../bounded-unknown.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { parseMarkdown, resolveSourceLocalFilePath } from '../../../core/markdown.ts';
import { resolveSlugForPath } from '../../../core/sync.ts';
import { scannerSlugRootMode } from '../../../core/write-through.ts';
import { getWorktreeBinding } from '../../../core/persistence/ownership.ts';
import { localHostId } from '../../../core/persistence/identity.ts';

const DOCS = 'docs/guides/repair.md#slug-path-mismatch';
/** Candidate rows one run reads (pages whose slug matches the pattern, in id order). */
export const SLUG_PATH_SCAN_LIMIT = 20_000;
/** Recorded files one run reads to tell stamped from unstamped. */
export const SLUG_PATH_FILE_LIMIT = 200;
const SAMPLE_LIMIT = 5;
const FILE_MAX_BYTES = 1 << 20;
/** Every slug slugifyPath changes matches: a hyphen run or edge hyphen, an empty segment, any character outside a-z0-9/._- (a superset: a CJK slug matches and derives unchanged). */
const CANDIDATE_PATTERN = '[^a-z0-9/._-]|--|-/|/-|^-|-$|//';

type FileVerdict = 'stamped' | 'unstamped' | 'file_missing' | 'no_checkout' | 'not_read';
interface Mismatch { source_id: string; slug: string; source_path: string; imports_as: string; file: FileVerdict }
type Checkout = { root: string; mode: 'git-root' | 'source-root' } | null;

/** This host's checkout of a source (its bound owner worktree, else its local path, else sync.repo_path for default), or null. */
async function checkoutOf(engine: BrainEngine, sourceId: string): Promise<Checkout> {
  const binding = await getWorktreeBinding(engine, sourceId);
  const [source] = binding ? [] : await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  const root = binding ? binding.owner_host_id === localHostId() && binding.local_path ? join(binding.local_path, binding.relative_path) : null
    : source?.local_path || (sourceId === 'default' ? await engine.getConfig('sync.repo_path') : null);
  return root && existsSync(root) ? { root, mode: await scannerSlugRootMode(engine, sourceId, root) } : null;
}

/** Whether the page's recorded file names the page in its `slug:` line, the stamp import keeps it by. */
function fileVerdict(checkout: Checkout, page: Mismatch): FileVerdict {
  if (!checkout) return 'no_checkout';
  const file = resolveSourceLocalFilePath(checkout.root, page.source_path, page.slug, checkout.mode) ?? join(checkout.root, page.source_path);
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > FILE_MAX_BYTES) return 'file_missing';
  return parseMarkdown(readFileSync(file, 'utf8'), page.source_path).slug === page.slug ? 'stamped' : 'unstamped';
}

async function runSlugPathMismatch(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const scope = doctorSourceIds(ctx);
    const rows = await engine.executeRaw<{ source_id: string; slug: string; source_path: string }>(
      `SELECT p.source_id, p.slug, p.source_path FROM pages p JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE
        WHERE p.deleted_at IS NULL AND NULLIF(btrim(p.source_path), '') IS NOT NULL AND p.slug ~ $1${scope ? ' AND p.source_id = ANY($2::text[])' : ''}
        ORDER BY p.id LIMIT ${SLUG_PATH_SCAN_LIMIT + 1}`, scope ? [CANDIDATE_PATTERN, scope] : [CANDIDATE_PATTERN]);
    const truncated = rows.length > SLUG_PATH_SCAN_LIMIT;
    const inspected = rows.slice(0, SLUG_PATH_SCAN_LIMIT);
    const mismatches: Mismatch[] = inspected.flatMap(row => {
      const importsAs = resolveSlugForPath(row.source_path);
      return importsAs === row.slug ? [] : [{ ...row, imports_as: importsAs, file: 'not_read' as FileVerdict }];
    });
    const checkouts = new Map<string, Checkout>();
    for (const page of mismatches.slice(0, SLUG_PATH_FILE_LIMIT)) {
      if (!checkouts.has(page.source_id)) checkouts.set(page.source_id, await checkoutOf(engine, page.source_id));
      page.file = fileVerdict(checkouts.get(page.source_id)!, page);
    }
    const count = (verdict: FileVerdict) => mismatches.filter(page => page.file === verdict).length;
    const files = { stamped: count('stamped'), unstamped: count('unstamped'), file_missing: count('file_missing'), no_checkout: count('no_checkout'), not_read: count('not_read') };
    const samples = (pages: Mismatch[]) => pages.slice(0, SAMPLE_LIMIT).map(page => ({ source_id: page.source_id, slug: page.slug, imports_as: page.imports_as,
      ...(ctx.remote ? {} : { source_path: page.source_path }), file: page.file }));
    const details = { count: mismatches.length, files, inspected: inspected.length, truncated, scan_limit: SLUG_PATH_SCAN_LIMIT, file_limit: SLUG_PATH_FILE_LIMIT, docs: DOCS };
    const unstamped = mismatches.filter(page => page.file === 'unstamped');
    if (unstamped.length) {
      const first = unstamped[0]!.source_id;
      checks.push({ name: 'slug_path_mismatch', status: 'warn', details: { ...details, sources: [...new Set(unstamped.map(page => page.source_id))], samples: samples(unstamped) },
        message: `${unstamped.length} live page(s) record a file whose path imports as another slug, and the file has no slug: line naming the page `
          + `(e.g. ${unstamped.slice(0, 3).map(page => `${page.source_id}:${page.slug} imports as ${page.imports_as}`).join(', ')}), so the next import or full sync of that file forks a second page. `
          + `Preview the fix with gbrain repair frontmatter --source ${first} (writes nothing; it proposes the slug: stamp as a safe repair).`,
        fix: agentFix(['gbrain', 'repair', 'frontmatter', '--source', first, '--json'],
          'Read-only preview: lists each file it would stamp with its page slug and prints the apply command with its hash. Apply only after the user agrees (it rewrites those files).',
          'slug_path_mismatch', { docs: DOCS }) });
      return checks;
    }
    // #7145: a check stopped by its own bound did not see everything, so its health is unknown.
    if (truncated || files.not_read) {
      checks.push({ name: 'slug_path_mismatch', status: 'warn', details: { ...details, ...boundUnknownDetails(truncated ? 'rows' : 'files'), samples: samples(mismatches) },
        message: `Unknown: the check reads at most ${SLUG_PATH_SCAN_LIMIT} candidate pages and ${SLUG_PATH_FILE_LIMIT} recorded files (no setting), and ${truncated ? 'more pages were' : `${files.not_read} file(s) were`} not checked. `
          + `None of the files read lacks its slug: line. Preview gbrain repair frontmatter --source <id> to check every file of a source.` });
      return checks;
    }
    checks.push({ name: 'slug_path_mismatch', status: 'ok', details: { ...details, samples: samples(mismatches) },
      message: mismatches.length
        ? `${mismatches.length} live page(s) have a slug their file path does not derive, and every file read here carries the slug: line that keeps its page `
          + `(${files.stamped} stamped, ${files.file_missing} missing, ${files.no_checkout} with no checkout on this host).`
        : `Every live page's slug is the one its recorded file path derives (${inspected.length} candidate(s) inspected).` });
  } catch (error) {
    checks.push(checkError('slug_path_mismatch', 'check live pages whose slug their recorded file path does not derive', error, { details: { count: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const slugPathMismatchEntry: DoctorEntry = { name: 'slug_path_mismatch', emits: ['slug_path_mismatch'], run: runSlugPathMismatch };
