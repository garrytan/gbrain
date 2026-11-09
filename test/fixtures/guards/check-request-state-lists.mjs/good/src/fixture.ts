const PENDING_STATES_SQL = 'see request-states.ts';
export const STUCK = `state IN (${PENDING_STATES_SQL})`;
