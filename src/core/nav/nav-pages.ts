/**
 * The brain's navigation files: index.md (every page by folder, one line each),
 * log.md (recent operations, newest first) and hot.md (a short "what is new"
 * page for the start of a session). `foresights nav` writes them at a source's root,
 * where sync skips them (SYNC_SKIP_FILES / SYNC_ROOT_SKIP_FILES), so they never
 * become searchable pages themselves.
 *
 * Each file is editable: only the block between NAV_BEGIN and NAV_END is
 * rebuilt, and text outside it is kept. A file that exists without the markers
 * is never overwritten. Pure: rendering and merging only, no I/O.
 */

export const NAV_BEGIN = '<!-- gbrain:nav:begin. Rebuilt by `foresights nav`; write your own notes above or below this block. -->';
export const NAV_END = '<!-- gbrain:nav:end -->';
const BEGIN_PREFIX = '<!-- gbrain:nav:begin';

/** Words in hot.md's rebuilt block at most. */
export const HOT_MAX_WORDS = 500;

export interface NavPage {
  slug: string;
  title: string;
  type: string | null;
  /** The page body (compiled truth); the summary is its first sentence. */
  body: string;
  updated_at: string;
}

export interface NavLogEntry {
  created_at: string;
  source_type: string;
  source_ref: string;
  summary: string;
  pages_updated: string[];
}

/** First plain sentence of a page body: headings, frontmatter, links and markup stripped, at most 120 characters. */
export function summarize(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('---') || line.startsWith('<!--') || line.startsWith('|') || line.startsWith('```')) continue;
    const text = line
      .replace(/^[-*>]\s+/, '')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
    return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}...` : sentence;
  }
  return '';
}

const day = (iso: string) => iso.slice(0, 10);
const link = (p: Pick<NavPage, 'slug' | 'title'>) => (p.title && p.title !== p.slug ? `[[${p.slug}|${p.title}]]` : `[[${p.slug}]]`);
const folderOf = (slug: string) => (slug.includes('/') ? slug.slice(0, slug.indexOf('/')) : '(top level)');

/** index.md's block: every page grouped by its top folder, folders and pages sorted, with a one-line summary. */
export function renderIndex(pages: NavPage[]): string {
  if (pages.length === 0) return 'No pages yet.';
  const byFolder = new Map<string, NavPage[]>();
  for (const p of pages) {
    const f = folderOf(p.slug);
    (byFolder.get(f) ?? byFolder.set(f, []).get(f)!).push(p);
  }
  const out = [`${pages.length} pages in ${byFolder.size} folders.`];
  for (const folder of [...byFolder.keys()].sort()) {
    const list = byFolder.get(folder)!.sort((a, b) => a.slug.localeCompare(b.slug));
    out.push('', `## ${folder} (${list.length})`, '');
    for (const p of list) {
      const s = summarize(p.body);
      out.push(`- ${link(p)}${s ? ` - ${s}` : ''}`);
    }
  }
  return out.join('\n');
}

/** log.md's block: operations newest first, naming only pages in `listed` (pages outside it are counted, not named). */
export function renderLog(entries: NavLogEntry[], listed: ReadonlySet<string>): string {
  if (entries.length === 0) return 'No operations recorded yet.';
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const named = e.pages_updated.filter(s => listed.has(s));
    const hidden = e.pages_updated.length - named.length;
    const pages = [...named.slice(0, 5).map(s => `[[${s}]]`), ...(named.length > 5 ? [`${named.length - 5} more`] : []),
      ...(hidden ? [`${hidden} not listed`] : [])].join(', ');
    const what = e.summary.trim().replace(/\s+/g, ' ') || e.source_ref;
    out.push(`- ${e.created_at.slice(0, 16).replace('T', ' ')} | ${e.source_type} | ${what}${pages ? ` | ${pages}` : ''}`);
  }
  return out.join('\n');
}

/** hot.md's block: recently changed pages and recent operations, cut to HOT_MAX_WORDS words. */
export function renderHot(recent: NavPage[], log: NavLogEntry[], listed: ReadonlySet<string>, inboxWaiting: number, now: Date): string {
  const out: string[] = [`As of ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, '', '## Changed recently', ''];
  if (recent.length === 0) out.push('Nothing changed in the last 7 days.');
  for (const p of recent) {
    const s = summarize(p.body);
    out.push(`- ${day(p.updated_at)} ${link(p)}${s ? ` - ${s}` : ''}`);
  }
  out.push('', '## Recent activity', '', renderLog(log.slice(0, 8), listed));
  if (inboxWaiting > 0) out.push('', `## Waiting`, '', `${inboxWaiting} file(s) in the inbox; capture them with \`foresights inbox run --once\`.`);
  const words = out.join('\n').split(/(\s+)/);
  let count = 0;
  let cut = words.length;
  for (let i = 0; i < words.length; i++) {
    if (/\S/.test(words[i]!) && ++count > HOT_MAX_WORDS) { cut = i; break; }
  }
  return cut < words.length ? `${words.slice(0, cut).join('').trimEnd()}\n\n(Cut at ${HOT_MAX_WORDS} words.)` : out.join('\n');
}

export type NavMerge =
  | { action: 'create' | 'update'; content: string }
  | { action: 'unchanged' }
  | { action: 'refuse'; reason: string };

/**
 * Put a rebuilt block into a navigation file. No file: create it with a title,
 * a line saying how it works, and the block. A file with the markers: replace
 * only the block, keep everything else. A file without them: refuse.
 */
export function mergeNavFile(existing: string | null, title: string, intro: string, block: string): NavMerge {
  const wrapped = `${NAV_BEGIN}\n${block.trimEnd()}\n${NAV_END}`;
  if (existing === null) return { action: 'create', content: `# ${title}\n\n${intro}\n\n${wrapped}\n` };
  const i = existing.indexOf(BEGIN_PREFIX);
  const j = existing.indexOf(NAV_END);
  if (i < 0 || j < i) {
    return { action: 'refuse', reason: 'it exists without the gbrain:nav markers, so it may be yours; nothing was changed. Rename it, or add the two marker lines where the rebuilt part should go.' };
  }
  const next = existing.slice(0, i) + wrapped + existing.slice(j + NAV_END.length);
  return next === existing ? { action: 'unchanged' } : { action: 'update', content: next };
}
