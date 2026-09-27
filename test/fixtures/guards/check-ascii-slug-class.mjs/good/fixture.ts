// GOOD: marked machine identifiers, Unicode classes, and shapes the guard ignores.
export function launchdLabel(id: string): string {
  // gbrain-allow-ascii-class: launchd label
  return `com.example.${id.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export function sameLineMarker(id: string): string {
  return id.replace(/[^a-z0-9-]/g, '-'); // gbrain-allow-ascii-class: source id charset
}

export function everyScript(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-');
}

export function isAsciiFlag(flag: string): boolean {
  return /^[a-z0-9-]+$/.test(flag);
}

export function nonLetterClass(s: string): string {
  // A comment that quotes .replace(/[^a-z0-9]+/g, '-') is not code.
  return s.replace(/[^_.]/g, '');
}
