/** File-plane MCP settings specific to native page images. */
export interface ImageMcpConfig {
  /** Owner opt-in for remote put_image; reads of owned images stay available. */
  publish_images?: boolean;
  image_max_source_bytes?: number;
  image_max_source_files?: number;
  image_max_page_bytes?: number;
  image_max_page_files?: number;
  image_max_versions_per_filename?: number;
}

export const IMAGE_MCP_CONFIG_KEYS = [
  'mcp.publish_images',
  'mcp.image_max_source_bytes',
  'mcp.image_max_source_files',
  'mcp.image_max_page_bytes',
  'mcp.image_max_page_files',
  'mcp.image_max_versions_per_filename',
] as const;
