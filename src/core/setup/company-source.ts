/**
 * GST-4043: the `gbrain sources add` arguments setup passes when it adds the company source before it labels people in
 * it. The brain still serves one person then, so the source is added isolated (config.federated = false): a one-person
 * brain's default would put company pages in default search. The flag is the sources command's, not setup's, so it
 * lives outside setup's own modules, which the flag registry scans for setup's flags (scripts/generate-flag-registry.ts).
 */
export const COMPANY_FIRST_ADD_ARGS: readonly string[] = ['--no-federated'];
