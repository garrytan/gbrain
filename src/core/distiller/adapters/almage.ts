/**
 * distiller/adapters/almage.ts — Almage export JSON → BrainRecord[].
 *
 * The Almage dataset exports `{ organizations, facilities, residents,
 * transmissions, users }`. The clinical content lives in `transmissions`
 * (care-home shift notes / observations). This adapter maps each transmission
 * to a `BrainRecord` the distiller's extractor can cluster.
 *
 * Keyless + pure. Format-specific by design (it knows the Almage shape); the
 * generic `BrainRecord` boundary keeps the rest of the distiller adapter-
 * agnostic. Tested against a synthetic fixture — NEVER commit real patient data.
 *
 * Role: transmissions carry `staffRole` / `staffRoleEn`, but they are often
 * null in the export. When absent/unknown the record defaults to the generalist
 * lane (`general-medicine`) — an honest fallback, since an untyped care-home
 * note is not specifically a nursing or psychiatric artifact. A caller with
 * better role signal can override via `opts.defaultRole` or `opts.inferRole`.
 */

import type { BrainRecord } from '../extract.ts';
import type { SkillRole } from '../types.ts';

/** The transmission fields this adapter reads (loose — extra fields ignored). */
export interface AlmageTransmission {
  id?: string;
  residentId?: string | null;
  transmissionDate?: string | null;
  staffRole?: string | null;
  staffRoleEn?: string | null;
  category?: string | null;
  categoryEn?: string | null;
  content?: string | null;
  contentEn?: string | null;
  catalogTags?: string[] | null;
}

/** The subset of the Almage export this adapter consumes. */
export interface AlmageExport {
  transmissions?: AlmageTransmission[] | null;
}

export interface AlmageAdapterOptions {
  /** Role used when a transmission carries no recognizable staff role. */
  defaultRole?: SkillRole;
  /** Custom role inference from the raw staff-role string (overrides default map). */
  inferRole?: (staffRole: string | null | undefined) => SkillRole | undefined;
  /** Prefer English content (`contentEn`) when present. Default true. */
  preferEnglish?: boolean;
}

/** Map a raw staff-role string to a canonical care lane, or undefined if unknown. */
export function inferRoleFromStaff(staffRole: string | null | undefined): SkillRole | undefined {
  if (!staffRole) return undefined;
  const s = staffRole.toLowerCase();
  if (/\bnurse\b|infirm|aide|caregiver|soign/.test(s)) return 'nurse';
  if (/psych/.test(s)) return 'psychiatrist';
  if (/\bdoctor\b|physician|médec|medec|general/.test(s)) return 'general-medicine';
  return undefined;
}

/**
 * Convert an Almage export into BrainRecords (one per non-empty transmission).
 * Transmissions with no textual content are skipped.
 */
export function almageExportToRecords(
  data: AlmageExport,
  opts: AlmageAdapterOptions = {},
): BrainRecord[] {
  const defaultRole = opts.defaultRole ?? 'general-medicine';
  const infer = opts.inferRole ?? inferRoleFromStaff;
  const preferEnglish = opts.preferEnglish ?? true;

  const records: BrainRecord[] = [];
  for (const [i, t] of (data.transmissions ?? []).entries()) {
    const text = ((preferEnglish ? t.contentEn : null) ?? t.content ?? t.contentEn ?? '').trim();
    if (text.length === 0) continue;

    const role = infer(t.staffRoleEn ?? t.staffRole) ?? defaultRole;

    // Tags: category (+ English) + catalog tags, lowercased + deduped.
    const tagSet = new Set<string>();
    for (const c of [t.categoryEn, t.category]) if (c) tagSet.add(c.toLowerCase().trim());
    for (const tag of t.catalogTags ?? []) if (tag) tagSet.add(String(tag).toLowerCase().trim());
    const tags = [...tagSet];

    const title = (t.categoryEn ?? t.category ?? 'transmission').replace(/_/g, ' ');

    records.push({
      id: t.id ?? `transmission-${i}`,
      text,
      role,
      tags: tags.length > 0 ? tags : undefined,
      title,
    });
  }
  return records;
}
