export type RequiredParityEngine = 'sqlite' | 'pglite';

export interface RequiredParityMatrixEntry {
  id: 'page-crud' | 'tags-links-timeline' | 'derived-jobs' | 'slug-rename';
  engines: readonly RequiredParityEngine[];
  required_operations: readonly string[];
  assertions: readonly string[];
}

const SQLITE_PGLITE = ['sqlite', 'pglite'] as const;

export const REQUIRED_PARITY_MATRIX: readonly RequiredParityMatrixEntry[] = [
  {
    id: 'page-crud',
    engines: SQLITE_PGLITE,
    required_operations: ['putPage', 'getPage', 'listPages', 'deletePage'],
    assertions: [
      'round-trip preserves page fields',
      'missing page returns null',
      'delete removes page and indexes',
    ],
  },
  {
    id: 'tags-links-timeline',
    engines: SQLITE_PGLITE,
    required_operations: ['addTag', 'getTags', 'addLink', 'getLinksForSlugs', 'getBacklinksForSlugs', 'addTimelineEntry', 'getTimeline'],
    assertions: [
      'tag filters match across engines',
      'forward and reverse links match across engines',
      'same-date timeline ordering matches across engines',
    ],
  },
  {
    id: 'derived-jobs',
    engines: SQLITE_PGLITE,
    required_operations: ['enqueueDerivedJob', 'listDerivedJobs', 'getDerivedIndexState'],
    assertions: [
      'derived job identity and status fields round-trip',
      'derived job list ordering is stable',
      'pending derived index state matches the queued job',
    ],
  },
  {
    id: 'slug-rename',
    engines: SQLITE_PGLITE,
    required_operations: ['renamePageSlug', 'getPage', 'getLinksForSlugs', 'getBacklinksForSlugs'],
    assertions: [
      'page slug moves without losing content',
      'links and backlinks point at the renamed slug',
    ],
  },
];
