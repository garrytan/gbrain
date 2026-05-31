// Timeline
export interface TimelineEntry {
  id: number;
  page_id: number;
  date: string;
  source: string;
  summary: string;
  detail: string;
  created_at: Date;
}

export interface TimelineInput {
  date: string;
  source?: string;
  summary: string;
  detail?: string;
}

export interface TimelineOpts {
  limit?: number;
  offset?: number;
  after?: string;
  before?: string;
}

// Raw data
export interface RawData {
  source: string;
  data: Record<string, unknown>;
  fetched_at: Date;
}

// Versions
export interface PageVersion {
  id: number;
  page_id: number;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  snapshot_at: Date;
}
