/** Strict parsing for the new provisioning front door, without changing legacy CLIs. */
export function validateHarnessArguments(args: string[], spec: {
  values?: readonly string[];
  flags?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  exclusive?: readonly (readonly string[])[];
}): void {
  const seen = new Set<string>();
  const values = new Set(spec.values ?? []);
  const flags = new Set(spec.flags ?? []);
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const flag = spec.aliases?.[raw] ?? raw;
    if (!values.has(flag) && !flags.has(flag)) throw new Error(`Unknown setup argument: ${raw}. Use --help for supported options.`);
    if (seen.has(flag)) throw new Error(`Duplicate setup argument: ${flag}`);
    seen.add(flag);
    if (values.has(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${raw} requires a value`);
    }
  }
  for (const group of spec.exclusive ?? []) {
    if (group.filter(flag => seen.has(flag)).length > 1) throw new Error(`Conflicting setup arguments: ${group.join(' and ')}`);
  }
}

export const MCP_GRANT_ARGUMENTS = {
  values: ['--harness', '--profile', '--source', '--url', '--client', '--if-version',
    '--federated-read', '--bound-tools', '--bound-source', '--bound-brain', '--bound-slug-prefixes',
    '--delegated-slug-prefixes', '--delegated-namespace', '--bound-max-concurrent', '--budget-usd-per-day',
    '--token-ttl', '--admin-token-file', '--credentials-out'],
  flags: ['--resume', '--dry-run', '--json'], aliases: { '--agent': '--harness' },
} as const;
