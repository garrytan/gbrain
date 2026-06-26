// src/core/office/extensions.ts
//
// Single source of truth for which file extensions route to the office adapter
// (Docling). Kept dependency-light so the file-collection walker (import.ts) and
// the per-file dispatch (import-file.ts) can both import it without pulling the
// heavy adapter graph.
//
// Only formats Docling parses AND that aren't already handled by gbrain's own
// paths. `.md` (markdown path) and images `.png/.jpg` (importImageFile) are
// deliberately NOT here. Docs: docs/proposals/office-ingest.md §10.

import { extname } from 'node:path';

export const OFFICE_EXTS = new Set([
  '.pdf', '.docx', '.pptx', '.xlsx', // M0
  '.odt', '.ods', '.odp', // OpenDocument trio (LibreOffice) — open equivalents of docx/pptx/xlsx
  '.html', '.htm', '.csv', // web pages + tabular data
]);

export function isOfficeFilePath(relativePath: string): boolean {
  return OFFICE_EXTS.has(extname(relativePath).toLowerCase());
}
