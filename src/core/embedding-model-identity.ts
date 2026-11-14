export function legacyUnprefixedModel(stored: string | null | undefined): stored is string {
  return Boolean(stored && !/[:/]/.test(stored) && /^[^\s]+$/.test(stored));
}

export function legacyModelTarget(stored: string | null | undefined, candidate: string): string | null {
  return legacyUnprefixedModel(stored) && candidate.endsWith(`:${stored}`) ? candidate : null;
}

export function sameEmbeddingModel(stored: string | null | undefined, target: string): boolean {
  return Boolean(stored && (stored === target || legacyModelTarget(stored, target) !== null));
}
