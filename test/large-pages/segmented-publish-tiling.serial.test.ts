/**
 * GST-1209 PGLite arm of test/helpers/segmented-publish-tiling-cases.ts. Serial: installs the process-wide fault hook.
 */
import { afterAll, beforeAll, describe } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { defineSegmentedPublishTilingCases } from '../helpers/segmented-publish-tiling-cases.ts';

describe('segmented publish tiling [pglite]', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  defineSegmentedPublishTilingCases({ getEngine: () => engine });
});
