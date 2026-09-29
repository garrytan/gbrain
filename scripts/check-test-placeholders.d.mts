export interface PlaceholderSite {
  path: string;
  line: number;
  form: string;
  test: string;
}

export interface AllowlistEntry {
  path: string;
  test?: string;
  reason: string;
  count?: number;
}

export function scanTree(treeRoot: string, fixtures: boolean): { files: string[]; sites: PlaceholderSite[] } | null;

export function evaluate(
  sites: PlaceholderSite[],
  allowlist: AllowlistEntry[],
  treeRoot: string,
): { problems: string[]; allowedSites: number };
