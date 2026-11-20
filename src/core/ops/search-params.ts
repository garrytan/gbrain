/**
 * Param definitions the `search` and `query` ops share (moved out of ops/search.ts, which holds the module-size ceiling).
 */

/** C1: the per-call row-shape escape hatch shared by `search` and `query` (`detail` is query's low/medium/high). */
export const FIELDS_PARAM = {
  type: 'string' as const,
  enum: ['lean', 'full'],
  description: "lean (remote default) or full.",
  fullSurfaceOnly: true,
};

/** Evidence delivery params shared by `search` and `query`. */
export const RETURN_UNIT_PARAM = {
  type: 'string' as const,
  enum: ['chunk', 'window', 'section', 'page', 'auto'],
  description: 'Default auto: whole conversations.',
};
export const RETURN_WINDOW_PARAM = {
  type: 'number' as const,
  minimum: 1,
  description: 'Window radius 1-3.',
  fullSurfaceOnly: true,
};
