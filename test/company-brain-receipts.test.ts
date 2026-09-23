import { afterAll, beforeAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sourceIngestionReceiptTests } from './helpers/company-brain-receipts.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120000);
afterAll(async () => { await engine?.disconnect(); });

sourceIngestionReceiptTests('source ingestion receipts (PGLite)', () => engine);
