/**
 * Re-export shim for backward compatibility (v0.32 — codex review #1).
 *
 * The 4-strategy LLM-JSON parser lives at src/core/eval-shared/json-repair.ts
 * so both cross-modal-eval (v0.27.x) and takes-quality-eval (v0.32) import
 * from one source of truth. Callers that imported `parseModelJSON`,
 * `ParsedScore`, or `ParsedModelResult` from this module path before the
 * hoist see zero behavior change — same names, same semantics, same
 * underlying implementation.
 *
 * The original plan only re-exported `parseModelJSON`; codex caught that
 * `cross-modal-eval/aggregate.ts:19` imports `ParsedModelResult` (a TYPE)
 * and the missing type re-export would have been a compile break. The
 * `export type` line below closes that gap.
 */
export { parseModelJSON } from '../eval-shared/json-repair.ts';
export type { ParsedScore, ParsedModelResult } from '../eval-shared/json-repair.ts';
