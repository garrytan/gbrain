// Page types
export type PageType =
  | 'person'
  | 'company'
  | 'deal'
  | 'yc'
  | 'civic'
  | 'project'
  | 'concept'
  | 'source'
  | 'media'
  | 'system';

export type ChunkSource = 'compiled_truth' | 'timeline' | 'frontmatter';

export interface CodemapPointer {
  path: string;
  symbol?: string;
  role: string;
  verified_at?: string;
  stale?: boolean;
}

export interface CodemapEntry {
  system: string;
  pointers: CodemapPointer[];
  vocabulary?: string;
}

export interface SystemEntryPoint {
  name: string;
  path: string;
  purpose: string;
}

export interface SystemFrontmatter {
  repo?: string;
  language?: string[];
  build_command?: string;
  test_command?: string;
  key_entry_points?: SystemEntryPoint[];
}

export interface Page {
  id: number;
  slug: string;
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
  created_at: Date;
  updated_at: Date;
  compiled_truth_changed_at: Date;
  timeline_changed_at: Date;
}

export interface PageInput {
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;
}

export type PageWindowField = 'compiled_truth' | 'timeline';

export interface PageTextWindowRequest {
  char_start?: number;
  char_limit: number;
}

export interface PageTextWindow {
  text: string;
  char_start: number;
  total_chars: number;
  returned_chars: number;
  next_char_start: number | null;
  has_more: boolean;
}

export interface PageProjection {
  id: number;
  slug: string;
  type: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
  created_at: Date;
  updated_at: Date;
  content_windows: Partial<Record<PageWindowField, PageTextWindow>>;
}

export interface PageProjectionOptions {
  windows?: Partial<Record<PageWindowField, PageTextWindowRequest>>;
}

export interface PageLineSpanProjectionOptions {
  line_start: number;
  line_end: number;
}

export interface PageLineSpanProjection {
  id: number;
  slug: string;
  type: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
  created_at: Date;
  updated_at: Date;
  text: string;
  line_start: number;
  line_end: number;
}

export interface PageFilters {
  type?: PageType;
  tag?: string;
  limit?: number;
  offset?: number;
}
