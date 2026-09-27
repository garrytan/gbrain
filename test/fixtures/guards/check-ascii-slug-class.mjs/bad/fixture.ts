// BAD: ASCII-only negated classes in replace() with no opt-out marker.
export function titleSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

export function labelKey(label: string): string {
  return label.replace(/[^\w-]/g, '');
}

export function caseKept(name: string): string {
  // gbrain-allow-ascii-class:
  return name.replaceAll(/[^A-Za-z]/g, '');
}
