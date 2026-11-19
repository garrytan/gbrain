/**
 * Filing modes: where a NEW page goes, by the method its source follows.
 *
 *   generic       by page type, in the folder the active schema pack gives that type
 *                 (person -> people/, company -> companies/, ...)
 *   para          by actionability: projects/<project>/, areas/<area>/,
 *                 resources/<type folder>/, archives/...
 *   lyt           atomic notes flat in notes/, maps of content in maps/
 *   zettelkasten  flat in zettel/, each note named by a time-sortable id
 *                 (YYYYMMDDHHmm) that never changes
 *
 * A mode only decides where a new page is suggested to go; it never moves an
 * existing page. Each source has its own mode (sources.config.filing_mode;
 * absent means generic). Pure: no I/O. The caller supplies the schema pack's
 * folder for the type and checks the suggested slug is free.
 */
import { slugifySegment } from '../sync.ts';

export const FILING_MODES = ['generic', 'para', 'lyt', 'zettelkasten'] as const;
export type FilingMode = (typeof FILING_MODES)[number];
export const DEFAULT_FILING_MODE: FilingMode = 'generic';

export function isFilingMode(value: unknown): value is FilingMode {
  return typeof value === 'string' && (FILING_MODES as readonly string[]).includes(value);
}

/** One line per mode, for help and `foresights filing show`. */
export const FILING_MODE_DESCRIPTIONS: Record<FilingMode, string> = {
  generic: 'by page type, in the folder the schema pack gives it (people/, companies/, concepts/ ...)',
  para: 'by actionability: projects/, areas/, resources/, archives/',
  lyt: 'atomic notes in notes/, linked from maps of content in maps/',
  zettelkasten: 'flat in zettel/, each note named by a time-sortable id that never changes',
};

export interface FilingRequest {
  /** The page type (person, concept, note, moc ...). */
  type: string;
  title: string;
  /** PARA: the project this page serves; it goes under projects/<project>/. */
  project?: string;
  /** PARA: the ongoing area of responsibility; it goes under areas/<area>/. */
  area?: string;
  /** PARA: file it under archives/ (finished or inactive). */
  archived?: boolean;
  /** The schema pack's folder for this type (its first path prefix, no trailing slash). */
  typeFolder?: string;
  /** Zettelkasten id time; default now. */
  now?: Date;
}

export interface FilingSuggestion {
  mode: FilingMode;
  /** The suggested slug (folder + name, no .md). */
  slug: string;
  folder: string;
  /** One plain sentence: why it goes there. */
  reason: string;
  /** Frontmatter fields the page should carry under this mode. */
  frontmatter: Record<string, string>;
}

const MOC_TYPES = new Set(['moc', 'map', 'map-of-content', 'hub', 'index']);

/** A folder for a type when the schema pack gives none: concept -> concepts, the rest the same way. */
function fallbackTypeFolder(type: string): string {
  const t = slugifySegment(type) || 'note';
  return t.endsWith('s') ? t : `${t}s`;
}

/** A slug-safe name from a title (at most 80 characters). */
export function titleSlug(title: string): string {
  return (slugifySegment(title) || 'untitled').slice(0, 80).replace(/-+$/, '') || 'untitled';
}

/** YYYYMMDDHHmm in UTC: sorts by creation time and never changes once given. */
export function zettelId(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

export function routeNewPage(mode: FilingMode, req: FilingRequest): FilingSuggestion {
  const name = titleSlug(req.title);
  const typeFolder = (req.typeFolder ?? '').replace(/\/+$/, '') || fallbackTypeFolder(req.type);
  const done = (folder: string, reason: string, frontmatter: Record<string, string> = {}, slugName = name): FilingSuggestion =>
    ({ mode, folder, slug: `${folder}/${slugName}`, reason, frontmatter });

  switch (mode) {
    case 'generic':
      return done(typeFolder, `filed by type: ${req.type} pages go in ${typeFolder}/`);
    case 'para': {
      const project = req.project ? titleSlug(req.project) : '';
      const area = req.area ? titleSlug(req.area) : '';
      if (req.archived) {
        const under = project ? `projects/${project}` : area ? `areas/${area}` : `resources/${typeFolder}`;
        return done(`archives/${under}`, 'finished or inactive, so it goes in archives/, keeping where it came from', { para: 'archive' });
      }
      if (project) return done(`projects/${project}`, `it serves the project ${req.project}, which has a goal and an end`, { para: 'project', project: req.project! });
      if (area) return done(`areas/${area}`, `it belongs to the ongoing area ${req.area}`, { para: 'area', area: req.area! });
      return done(`resources/${typeFolder}`, 'no project or area named, so it is reference material in resources/', { para: 'resource' });
    }
    case 'lyt':
      if (MOC_TYPES.has(req.type.toLowerCase())) {
        return done('maps', 'a map of content: it links the atomic notes on one topic', { methodology_role: 'moc' });
      }
      return done('notes', 'one idea per note, flat in notes/; link it from a map of content in maps/', { methodology_role: 'atomic' });
    case 'zettelkasten': {
      const id = zettelId(req.now ?? new Date());
      return done('zettel', `named by its id ${id}, which never changes, so links to it never break`, { zettel_id: id, methodology_role: 'zettel' }, `${id}-${name}`);
    }
  }
}
