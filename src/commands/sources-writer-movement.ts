/**
 * GST-2688: the path `gbrain upgrade` from about v0.60.150 to v0.60.248 loads
 * into the OLD process after the new release is on disk
 * (`(await import('./sources-writer-movement.ts')).MOVEMENT_SUPERVISOR_STEP`).
 * That process keeps its old copies of every module it already loaded, so a
 * newer module pulled in from here that imports a newer export from one of
 * them throws and the upgrade exits 1. Keep this file a leaf: it re-exports
 * the step from the import-free movement-step.ts and nothing else
 * (test/upgrade-old-updater-leaf.test.ts). The command is
 * sources-writer-movement-cli.ts.
 */
export { MOVEMENT_SUPERVISOR_STEP } from './movement-step.ts';
