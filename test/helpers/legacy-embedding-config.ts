/**
 * The pinned test-suite embedding shape (OpenAI legacy 1536-d).
 *
 * ONE definition, two consumers (W0 fix-wave — no hand-copied twins):
 *   - test/helpers/legacy-embedding-preload.ts (bunfig preload) pins the
 *     gateway to this shape for every `bun test` file.
 *   - scripts/build-pglite-snapshot.ts builds the snapshot fixture under the
 *     SAME shape, so the baked vector(dims) columns match what the pinned
 *     tests write. (The W0 incident: the build script ran with an
 *     unconfigured gateway → shipped-default 1280-d columns → every
 *     1536-d-writing test failed with "expected 1280 dimensions, not 1536"
 *     the moment the snapshot became default-on.)
 */
export const LEGACY_EMBEDDING_CONFIG = {
  embedding_model: 'openai:text-embedding-3-large',
  embedding_dimensions: 1536,
} as const;
