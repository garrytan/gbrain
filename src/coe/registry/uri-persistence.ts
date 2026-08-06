interface PersistedQueryParameterRule {
  max_occurrences: number;
  applies_to: (uri: URL) => boolean;
  accepts: (value: string) => boolean;
}

const PERSISTED_QUERY_PARAMETER_RULES = new Map<string, PersistedQueryParameterRule>([
  ["recursive", {
    max_occurrences: 1,
    applies_to: (uri) => (
      uri.protocol === "https:"
      && uri.hostname === "api.github.com"
      && /^\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/]+$/.test(uri.pathname)
    ),
    accepts: (value) => value === "0" || value === "1",
  }],
]);

/**
 * Return the URI representation permitted in journals, projections, and errors.
 * Transport callers may keep a separate URL containing parameters needed for the
 * request, but no parameter absent from this allowlist crosses the persistence
 * boundary. Allowed names also validate values and cardinality to prevent covert
 * secret storage through an otherwise approved parameter.
 */
export function canonicalizeUriForPersistence(value: string | URL): string {
  const uri = new URL(value);
  uri.username = "";
  uri.password = "";
  uri.hash = "";

  const retained = new URLSearchParams();
  for (const [name, rule] of PERSISTED_QUERY_PARAMETER_RULES) {
    if (!rule.applies_to(uri)) continue;
    const values = uri.searchParams.getAll(name);
    if (
      values.length > 0
      && values.length <= rule.max_occurrences
      && values.every(rule.accepts)
    ) {
      for (const parameterValue of values) retained.append(name, parameterValue);
    }
  }
  uri.search = retained.toString();
  return uri.toString();
}
