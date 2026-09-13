export function assertValidSlugPrefixes(prefixes: readonly string[]): void {
  for (const p of prefixes) {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new Error('bound_slug_prefixes entries must be non-empty, non-whitespace slug prefixes (e.g. "emp-alice/")');
    }
    if (p !== p.trim()) {
      throw new Error(`bound_slug_prefixes entry "${p}" has leading/trailing whitespace; slugs never do, so it would fence nothing`);
    }
    // Slugs are lowercased by validateSlug before storage, so a prefix with
    // uppercase in it cannot correspond to anything actually written.
    if (p !== p.toLowerCase()) {
      throw new Error(`bound_slug_prefixes entry "${p}" must be lowercase; stored slugs are lowercased, so a mixed-case prefix fences unpredictably`);
    }
    // Require an explicit segment boundary. Slug namespaces collide on their
    // own naming scheme — `emp-alice` and `emp-alice-2` are different people —
    // and a boundary-less entry reads as "everything starting with these
    // characters". The matcher is boundary-aware regardless, but saying it at
    // registration is what stops an operator writing a binding whose meaning
    // isn't what it looks like.
    if (!p.endsWith('/') && !p.endsWith('/*')) {
      throw new Error(`bound_slug_prefixes entry "${p}" must end with "/" (or "/*"); a boundary-less prefix reads as a character prefix, so "${p}" would look like it covers only "${p}/..." while naming sibling namespaces like "${p}-2/..."`);
    }
  }
}

export function pgArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '{}';
  const escaped = arr.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}
