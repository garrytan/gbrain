import type { PageType } from './types.ts';

export type RelationshipType =
  | 'mentions'
  | 'works_at'
  | 'invested_in'
  | 'founded'
  | 'advises'
  | 'attended'
  | 'source'
  | 'related_to'
  | 'discussed_in'
  | 'yc_partner'
  | 'led_round'
  | 'involved_in'
  | 'deal_for';

export interface FrontmatterLinkFieldMapping {
  fields: string[];
  pageType?: string;
  type: RelationshipType;
  direction: 'outgoing' | 'incoming';
  dirHint: string | string[];
}

export interface PageTypeInferenceRule {
  patterns: string[];
  type: PageType;
}

export const ENTITY_REFERENCE_DIRS = [
  'people',
  'companies',
  'meetings',
  'concepts',
  'deal',
  'civic',
  'project',
  'projects',
  'source',
  'media',
  'yc',
  'tech',
  'finance',
  'personal',
  'openclaw',
  'entities',
] as const;

export const BACKLINK_ENTITY_DIRS = ['people', 'companies'] as const;
export const HEALTH_ENTITY_PAGE_TYPES = ['person', 'company'] as const;

export function enrichmentSlugPrefixForEntityType(type: 'person' | 'company'): (typeof BACKLINK_ENTITY_DIRS)[number] {
  // Today enrichment only creates people/* and companies/* stubs; keep that mapping explicit
  // so call sites don't re-derive 'people' vs 'companies' literals.
  return type === 'person' ? BACKLINK_ENTITY_DIRS[0] : BACKLINK_ENTITY_DIRS[1];
}

export const RELATIONSHIP = Object.freeze({
  MENTIONS: 'mentions',
  WORKS_AT: 'works_at',
  INVESTED_IN: 'invested_in',
  FOUNDED: 'founded',
  ADVISES: 'advises',
  ATTENDED: 'attended',
  SOURCE: 'source',
  RELATED_TO: 'related_to',
  DISCUSSED_IN: 'discussed_in',
  YC_PARTNER: 'yc_partner',
  LED_ROUND: 'led_round',
  INVOLVED_IN: 'involved_in',
  DEAL_FOR: 'deal_for',
} as const satisfies Record<string, RelationshipType>);

export const FRONTMATTER_RELATIONSHIP_MAP: readonly FrontmatterLinkFieldMapping[] = [
  // Person pages → companies
  { fields: ['company', 'companies'], pageType: 'person', type: RELATIONSHIP.WORKS_AT, direction: 'outgoing', dirHint: 'companies' },
  { fields: ['founded'], pageType: 'person', type: RELATIONSHIP.FOUNDED, direction: 'outgoing', dirHint: 'companies' },
  // Company pages (incoming relationships — subject of the verb lives elsewhere)
  { fields: ['key_people'], pageType: 'company', type: RELATIONSHIP.WORKS_AT, direction: 'incoming', dirHint: 'people' },
  { fields: ['partner'], pageType: 'company', type: RELATIONSHIP.YC_PARTNER, direction: 'incoming', dirHint: 'people' },
  { fields: ['investors'], pageType: 'company', type: RELATIONSHIP.INVESTED_IN, direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
  // Deal pages (all incoming — deals are the object)
  { fields: ['investors'], pageType: 'deal', type: RELATIONSHIP.INVESTED_IN, direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
  { fields: ['lead'], pageType: 'deal', type: RELATIONSHIP.LED_ROUND, direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
  // Meeting pages
  { fields: ['attendees'], pageType: 'meeting', type: RELATIONSHIP.ATTENDED, direction: 'incoming', dirHint: 'people' },
  // Any page type
  { fields: ['sources'], type: RELATIONSHIP.DISCUSSED_IN, direction: 'incoming', dirHint: ['source', 'media'] },
  { fields: ['source'], type: RELATIONSHIP.SOURCE, direction: 'outgoing', dirHint: '' },
  { fields: ['related', 'see_also'], type: RELATIONSHIP.RELATED_TO, direction: 'outgoing', dirHint: '' },
];

// Mirrors src/core/markdown.ts inferType() precedence.
export const PAGE_TYPE_INFERENCE_RULES: readonly PageTypeInferenceRule[] = [
  // Stronger subtypes first.
  { patterns: ['/writing/'], type: 'writing' },
  { patterns: ['/wiki/analysis/'], type: 'analysis' },
  { patterns: ['/wiki/guides/', '/wiki/guide/'], type: 'guide' },
  { patterns: ['/wiki/hardware/'], type: 'hardware' },
  { patterns: ['/wiki/architecture/'], type: 'architecture' },
  { patterns: ['/wiki/concepts/', '/wiki/concept/'], type: 'concept' },
  // Core entity/content dirs.
  { patterns: ['/people/', '/person/'], type: 'person' },
  { patterns: ['/companies/', '/company/'], type: 'company' },
  { patterns: ['/deals/', '/deal/'], type: 'deal' },
  { patterns: ['/yc/'], type: 'yc' },
  { patterns: ['/civic/'], type: 'civic' },
  { patterns: ['/projects/', '/project/'], type: 'project' },
  { patterns: ['/sources/', '/source/'], type: 'source' },
  { patterns: ['/media/'], type: 'media' },
  // Inbox/chat/calendar/note/feed types.
  { patterns: ['/emails/', '/email/'], type: 'email' },
  { patterns: ['/slack/'], type: 'slack' },
  { patterns: ['/cal/', '/calendar/'], type: 'calendar-event' },
  { patterns: ['/notes/', '/note/'], type: 'note' },
  { patterns: ['/meetings/', '/meeting/'], type: 'meeting' },
];

export function buildEntityDirRegexFragment(dirs: readonly string[] = ENTITY_REFERENCE_DIRS): string {
  // The extractor regex expects the non-capturing group form: (?:a|b|c)
  return `(?:${dirs.join('|')})`;
}

const ENTITY_DIR_SET = new Set<string>(ENTITY_REFERENCE_DIRS as readonly string[]);
const BACKLINK_DIR_SET = new Set<string>(BACKLINK_ENTITY_DIRS as readonly string[]);
const HEALTH_TYPE_SET = new Set<string>(HEALTH_ENTITY_PAGE_TYPES as readonly string[]);

export function isEntityReferenceDir(dir: string): boolean {
  return ENTITY_DIR_SET.has(dir);
}

export function isBacklinkEntityDir(dir: string): boolean {
  return BACKLINK_DIR_SET.has(dir);
}

export function isHealthEntityPageType(type: string): type is 'person' | 'company' {
  return HEALTH_TYPE_SET.has(type);
}

export function inferPageTypeFromPath(filePath?: string): PageType {
  if (!filePath) return 'concept';
  const lower = ('/' + filePath).toLowerCase();
  for (const rule of PAGE_TYPE_INFERENCE_RULES) {
    for (const p of rule.patterns) {
      if (lower.includes(p)) return rule.type;
    }
  }
  return 'concept';
}

export function inferFsLinkTypeByTopDirs(
  fromTopDir: string,
  toTopDir: string,
  frontmatter?: Record<string, unknown>,
): RelationshipType {
  const from = fromTopDir.split('/')[0];
  const to = toTopDir.split('/')[0];
  if (from === 'people' && to === 'companies') {
    if (Array.isArray(frontmatter?.founded)) return RELATIONSHIP.FOUNDED;
    return RELATIONSHIP.WORKS_AT;
  }
  if (from === 'people' && to === 'deals') return RELATIONSHIP.INVOLVED_IN;
  if (from === 'deals' && to === 'companies') return RELATIONSHIP.DEAL_FOR;
  if (from === 'meetings' && to === 'people') return RELATIONSHIP.ATTENDED;
  return RELATIONSHIP.MENTIONS;
}

