// Natural-language task module — public API surface.
// Re-exported by admin-console.ts via `export * from './natural-lang/index.ts'`.

// Types
export type { ConsoleIntent, IntentPreview, ConsoleRun } from './types.ts';
export { INTENTS, INTENT_SLOT_KEYS, MAX_NATURAL_TASK_CHARACTERS } from './types.ts';

// Prompt
export { INTENT_SYSTEM_PROMPT, PMBRAIN_ACTION_TOOL } from './prompt.ts';

// LLM
export { callIntentModel, getAdminLlmStatus, buildAdminGatewayConfig, parseJsonObject } from './llm.ts';

// Normalize
export { normalizeIntentPreview, validateSlots, describeAction } from './normalize.ts';

// Commands
export { commandForPreview, resolveCliEntry } from './commands.ts';

// Executor
export { startRun, getRun, listRuns, cancelRun, sanitizeOutput, type RunHooks } from './executor.ts';

// High-level API
export {
  previewIntent,
  executePreview,
  startCaptureRun,
  buildCaptureCommand,
  startImportRun,
  startThinkRun,
  startMarkdownExportRun,
  buildMarkdownExportCommand,
  startSourceAddRun,
  buildDreamCommand,
  startDreamRun,
  startActionRun,
  deriveSourceIdFromPath,
  resolveImportSourceIdForPath,
} from './api.ts';
