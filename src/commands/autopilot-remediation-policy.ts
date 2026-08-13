export const AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES = 60;

export interface AutopilotRemediationPlanShape {
  score: number;
  planLength: number;
  estimatedSeconds: number;
  minutesSinceLastFull: number;
}

/**
 * Keep recommendation keys stable for doctor/remediate checkpoints while
 * giving Autopilot a fresh single-flight slot on every dispatch interval.
 */
export function autopilotRemediationIdempotencyKey(
  recommendationKey: string,
  dispatchSlot: string,
): string {
  return `${recommendationKey}:autopilot:${dispatchSlot}`;
}

/**
 * A full cycle is a freshness invariant, independent of the current score or
 * targeted plan. Large/slow/severely degraded plans retain the existing
 * hammer behavior before the freshness floor is reached.
 */
export function shouldRunAutopilotFullCycle({
  score,
  planLength,
  estimatedSeconds,
  minutesSinceLastFull,
}: AutopilotRemediationPlanShape): boolean {
  return minutesSinceLastFull >= AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES
    || planLength > 3
    || estimatedSeconds >= 300
    || score < 70;
}

export function shouldSleepHealthyAutopilot(
  score: number,
  planLength: number,
  minutesSinceLastFull: number,
): boolean {
  return score >= 95
    && planLength === 0
    && minutesSinceLastFull < AUTOPILOT_FULL_CYCLE_FLOOR_MINUTES;
}
