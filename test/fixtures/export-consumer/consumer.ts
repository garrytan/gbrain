/**
 * External consumer fixture (refactor wave 1: O13).
 *
 * Imports one runtime export from EVERY package.json `exports` subpath through the
 * package name, plus the core public types, exactly as a downstream consumer would.
 * `bun run typecheck` (tsconfig includes test/) typechecks it against the
 * candidate; `test/export-surface-golden.test.ts` imports it at runtime and
 * checks it covers every subpath. Downstream users need zero import edits.
 */

import { ALL_PAGE_TYPES as e00 } from 'gbrain';
import { ALL_FACT_KINDS as e01 } from 'gbrain/engine';
import { ALL_PAGE_TYPES as e02 } from 'gbrain/types';
import { CLIENT_FENCED_WRITE_OPS as e03 } from 'gbrain/operations';
import { MinionQueue as e04 } from 'gbrain/minions';
import { createEngine as e05 } from 'gbrain/engine-factory';
import { PGLiteEngine as e06 } from 'gbrain/pglite-engine';
import { FRONTMATTER_LINK_MAP as e07 } from 'gbrain/link-extraction';
import { MAX_FILE_SIZE as e08 } from 'gbrain/import-file';
import { transcribe as e09 } from 'gbrain/transcription';
import { EMBEDDING_COST_PER_1K_TOKENS as e10 } from 'gbrain/embedding';
import { CWD_DOTENV_FILES as e11 } from 'gbrain/config';
import { coerceFrontmatterString as e12 } from 'gbrain/markdown';
import { _resetForTest as e13 } from 'gbrain/backoff';
import { AUTO_LOW_COMPILED_TRUTH_TILT as e14 } from 'gbrain/search/hybrid';
import { expandQuery as e15 } from 'gbrain/search/expansion';
import { READER_MAX_SESSION_CHARS as e16 } from 'gbrain/eval/longmemeval/reader';
import { __thinkAdapter as e17 } from 'gbrain/think';
import { DEFAULT_EMBEDDING_DIMENSIONS as e18 } from 'gbrain/ai/gateway';
import { hasAIInvocationGuard as e19 } from 'gbrain/ai/invocation-guard';
import { ANTHROPIC_CACHE_READ_MULT as e20 } from 'gbrain/core/model-pricing';
import { STALE_TIME_BUDGET_MS as e21 } from 'gbrain/extract';
import { INGESTION_CONTENT_TYPES as e22 } from 'gbrain/ingestion';
import { IngestionTestHarness as e23 } from 'gbrain/ingestion/test-harness';
import { GuardrailLoadError as e24 } from 'gbrain/core/guardrails';
import { loadHeldOut as e25 } from 'gbrain/core/skillopt';
import { LiveServeLockError as e26 } from 'gbrain/pglite-lock';
import { assembleEvidenceForHits as e27 } from 'gbrain/search/evidence-delivery';
import type { BrainEngine } from 'gbrain/engine';
import type { PageInput, SearchResult } from 'gbrain/types';
import { PGLiteEngine } from 'gbrain/pglite-engine';

export const RUNTIME_IMPORTS: readonly unknown[] = [
  e00,
  e01,
  e02,
  e03,
  e04,
  e05,
  e06,
  e07,
  e08,
  e09,
  e10,
  e11,
  e12,
  e13,
  e14,
  e15,
  e16,
  e17,
  e18,
  e19,
  e20,
  e21,
  e22,
  e23,
  e24,
  e25,
  e26,
  e27,
];

export function makeEngine(): BrainEngine {
  return new PGLiteEngine();
}

export async function readPage(engine: BrainEngine, slug: string): Promise<unknown> {
  return engine.getPage(slug);
}

export function describeInput(input: PageInput, hits: SearchResult[]): string {
  return `${input.title}:${hits.length}`;
}
