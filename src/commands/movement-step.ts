/**
 * #6604: the step `gbrain upgrade` and `gbrain post-upgrade` print for the supervisor. A leaf with no imports, so
 * upgrade.ts loads it statically before the swap instead of pulling the movement command graph into the old process.
 * Bare command (no flags), so it inherits the default window.
 */
export const MOVEMENT_SUPERVISOR_STEP = 'after restarting serve and the workers, run: gbrain sources writer movement';
