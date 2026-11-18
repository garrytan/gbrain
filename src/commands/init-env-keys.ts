/**
 * Near-miss key names for `gbrain init`: an env var that looks like a typo of a
 * provider's required key (OPENAPI_API_KEY for OPENAI_API_KEY). init stops on
 * one, because finishing keyless would bury the user's typo. Re-exported by
 * commands/init.ts.
 */

/** Look at env-vars the user set that look like typos of recipe-required keys.
 *  Exported for unit tests (parameterizable via env arg). */
export async function findEnvKeyTypos(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ userSet: string; suggested: string }>> {
  const { suggestNearest, editDistance } = await import('../core/levenshtein.ts');
  const { listRecipes } = await import('../core/ai/recipes/index.ts');
  // Build the canonical name set from every recipe's auth_env.required.
  const canonical = new Set<string>();
  for (const r of listRecipes()) {
    for (const k of r.auth_env?.required ?? []) canonical.add(k);
  }
  const out: Array<{ userSet: string; suggested: string }> = [];
  // Walk user env vars that look API-key-shaped to keep the suggestion noise low.
  const KEY_SHAPE = /^[A-Z][A-Z0-9_]*_(API_)?KEY$/;
  for (const userKey of Object.keys(env)) {
    if (!KEY_SHAPE.test(userKey)) continue;
    if (canonical.has(userKey)) continue;        // exact match, not a typo
    if (!env[userKey]) continue;                  // empty string, skip
    const suggestion = suggestNearest(userKey, [...canonical], /* maxDistance */ 3);
    // A typo keeps most of the provider name. EXA_API_KEY is 3 edits from
    // NAN_API_KEY, but it names another service, so the edits must be at most
    // half the canonical provider name ("NAN" allows 1, "OPENAI" allows 3).
    if (suggestion && suggestion !== userKey
      && editDistance(userKey, suggestion) * 2 <= suggestion.replace(/_(API_)?KEY$/, '').length) {
      // False-positive guard (per plan D13): suggested canonical not ALSO set.
      if (!env[suggestion]) {
        out.push({ userSet: userKey, suggested: suggestion });
      }
    }
  }
  return out;
}
