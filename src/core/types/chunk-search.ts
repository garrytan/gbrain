import type { DerivedArtifactKind, DerivedIndexStatus } from './derived-jobs.ts';
import type { ChunkSource, PageType } from './page.ts';

// Chunks
export interface Chunk {
  id: number;
  page_id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: ChunkSource;
  chunk_content_hash: string;
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: ChunkSource;
  embed_context?: string;
  embedding_input_version?: string;
  embedding?: Float32Array;
  clear_embedding?: boolean;
  model?: string;
  token_count?: number;
}

// Search
export interface SearchResult {
  slug: string;
  page_id: number;
  title: string;
  type: PageType;
  chunk_text: string;
  chunk_source: ChunkSource;
  chunk_index?: number | null;
  chunk_content_hash?: string | null;
  score: number;
  stale: boolean;
  updated_at?: Date;
  superseded_by?: string | null;
  derived_artifact_kind?: DerivedArtifactKind;
  derived_status?: DerivedIndexStatus;
  derived_target_content_hash?: string | null;
  derived_indexed_content_hash?: string | null;
  derived_warning?: string;
}

export interface SearchOpts {
  limit?: number;
  type?: PageType;
  exclude_slugs?: string[];
  updated_after?: Date | string;
  updated_before?: Date | string;
}

// Links
export interface Link {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

export interface GraphNode {
  slug: string;
  title: string;
  type: PageType;
  depth: number;
  links: { to_slug: string; link_type: string }[];
}
