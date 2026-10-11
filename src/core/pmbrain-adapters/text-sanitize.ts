import { ensureWellFormed } from '../text-safe.ts';
export const sanitizeForJsonb = (s: string): string => ensureWellFormed(s.replace(/\0/g, ''));
