const CONTROL_CHARS_EXCEPT_TAB_NEWLINE = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F]/g;

export function stripControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARS_EXCEPT_TAB_NEWLINE, '');
}

export function sanitizeOwnerReferences(value: string, ownerName: string, ownerAliases: string[] = []): string {
  const canonicalOwner = ownerName.trim();
  if (!canonicalOwner) {
    return value;
  }

  let rewritten = value;

  const aliases = uniqueAliases(canonicalOwner, ownerAliases);
  for (const alias of aliases) {
    if (alias.toLowerCase() === canonicalOwner.toLowerCase()) {
      continue;
    }
    rewritten = replaceWholeWord(rewritten, alias, canonicalOwner);
  }

  rewritten = rewritten
    .replace(/\b(I|me|myself)\b/gi, canonicalOwner)
    .replace(/\bmy\b/gi, `${canonicalOwner}'s`)
    .replace(/\byourself\b/gi, canonicalOwner)
    .replace(/\byou\b/gi, canonicalOwner)
    .replace(/\byour\b/gi, `${canonicalOwner}'s`)
    .replace(/\byours\b/gi, `${canonicalOwner}'s`);

  return rewritten;
}

export function sanitizeDraftInputText(value: string, ownerName: string, ownerAliases: string[] = []): string {
  const withoutControlChars = stripControlCharacters(value);
  return sanitizeOwnerReferences(withoutControlChars, ownerName, ownerAliases);
}

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function uniqueAliases(ownerName: string, ownerAliases: string[]): string[] {
  const seen = new Set<string>();
  const aliases = [ownerName, ...ownerAliases.map((alias) => alias.trim()).filter(Boolean)];
  const unique: string[] = [];

  for (const alias of aliases) {
    const normalized = alias.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(alias);
  }

  return unique;
}

function replaceWholeWord(value: string, source: string, replacement: string): string {
  const pattern = new RegExp(`\\b${escapeRegex(source)}\\b`, 'gi');
  return value.replace(pattern, replacement);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
