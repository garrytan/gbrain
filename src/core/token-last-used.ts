/**
 * In-process cooldown for access_tokens.last_used_at writes.
 *
 * Every authenticated request is still logged in mcp_request_log. This only cools
 * the legacy access_tokens row touch so a hot token does not become a hot row.
 */
export const ACCESS_TOKEN_LAST_USED_COOLDOWN_MS = 60_000;
export const ACCESS_TOKEN_LAST_USED_MAX_ENTRIES = 10_000;

export class LastUsedAtCooldown {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly cooldownMs = ACCESS_TOKEN_LAST_USED_COOLDOWN_MS,
    private readonly maxEntries = ACCESS_TOKEN_LAST_USED_MAX_ENTRIES,
  ) {}

  shouldWrite(key: string, nowMs = Date.now()): boolean {
    const previous = this.seen.get(key);
    if (previous !== undefined && nowMs - previous < this.cooldownMs) {
      return false;
    }

    this.seen.delete(key);
    this.seen.set(key, nowMs);
    this.evictOverflow();
    return true;
  }

  clear(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }

  private evictOverflow(): void {
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) return;
      this.seen.delete(oldest);
    }
  }
}

export const accessTokenLastUsedCooldown = new LastUsedAtCooldown();

export function shouldUpdateAccessTokenLastUsed(key: string, nowMs = Date.now()): boolean {
  return accessTokenLastUsedCooldown.shouldWrite(key, nowMs);
}
