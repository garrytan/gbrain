// Stats + Health
export interface BrainStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  timeline_entry_count: number;
  pages_by_type: Record<string, number>;
}

export interface BrainHealth {
  page_count: number;
  embed_coverage: number;
  stale_pages: number;
  orphan_pages: number;
  dead_links: number;
  missing_embeddings: number;
}

// Ingest log
export interface IngestLogEntry {
  id: number;
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
  created_at: Date;
}

export interface IngestLogInput {
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
}
