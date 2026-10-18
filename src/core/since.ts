/**
 * #6712 PR 2 (L4): the one `--since` parser. A relative age (`90s`, `15m`, `6h`, `7d`) or an ISO-8601 instant
 * (`2026-10-01`, `2026-10-01T12:00:00Z`) becomes one concrete instant, so a command that prints its own follow-up
 * (`gbrain repair file-drift ... --since`, `gbrain agent logs --since`) prints that instant, never the relative age:
 * the same command run later selects the same rows and its plan hash still matches.
 */
const RELATIVE = /^(\d+)\s*(s|m|h|d)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The instant `input` names (ISO string), `undefined` for an empty value; throws on anything else. */
export function parseSince(input: string | undefined, flag = '--since', now = Date.now()): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  const relative = RELATIVE.exec(trimmed);
  if (relative) return new Date(now - Number(relative[1]) * UNIT_MS[relative[2]!.toLowerCase()]!).toISOString();
  const at = ISO_DATE.test(trimmed) ? new Date(trimmed) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw new Error(`${flag}: could not parse "${input}" as ISO-8601 (2026-10-01 or 2026-10-01T12:00:00Z) or relative (e.g. "5m", "1h", "7d")`);
  }
  return at.toISOString();
}
