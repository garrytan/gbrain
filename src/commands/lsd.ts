/**
 * gbrain lsd — Lateral Synaptic Drift.
 *
 * Thin re-export of the LSD profile entry point from brainstorm.ts. The
 * orchestrator + judges are shared (per D6 + D14); only the profile defaults
 * differ. Lives in its own file so `gbrain lsd --help` reads cleanly via the
 * CLI dispatch table and the user sees `lsd` as a first-class command, not
 * a flag on brainstorm.
 *
 * See `src/commands/brainstorm.ts` for the shared CLI body and
 * `src/core/brainstorm/orchestrator.ts` for the profile configs.
 */

export { runLsdCommand } from './brainstorm.ts';
