export function resolveAutopilotDispatchTimeoutMs(
  baseIntervalSeconds: number,
  fullCycle: boolean,
): number {
  const intervalDerivedTimeoutMs = Math.max(baseIntervalSeconds * 2 * 1000, 300_000);
  return fullCycle
    ? Math.max(intervalDerivedTimeoutMs, 1_800_000)
    : intervalDerivedTimeoutMs;
}
