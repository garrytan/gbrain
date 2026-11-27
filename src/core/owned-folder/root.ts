/**
 * The reserved top-level folder of the default source's checkout (GST-3022). Not `.gbrain/`, which holds access.yml.
 * Its own module with no imports, so sync.ts (which the chunker and the embedded binary load) names it without
 * pulling in the operation contract.
 */
export const OWNED_FOLDER_ROOT = '.gbrain-owned';
