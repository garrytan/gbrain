import type { BrainEngine } from '../engine.ts';
import type { NoteManifestEntry, NoteSectionEntry } from '../types.ts';

const STRUCTURAL_ENTRY_BATCH_SIZE = 5000;

export async function listAllNoteManifestEntries(
  engine: BrainEngine,
  scopeId: string,
): Promise<NoteManifestEntry[]> {
  const manifests: NoteManifestEntry[] = [];

  for (let offset = 0; ; offset += STRUCTURAL_ENTRY_BATCH_SIZE) {
    const batch = await engine.listNoteManifestEntries({
      scope_id: scopeId,
      limit: STRUCTURAL_ENTRY_BATCH_SIZE,
      offset,
    });
    manifests.push(...batch);
    if (batch.length < STRUCTURAL_ENTRY_BATCH_SIZE) {
      break;
    }
  }

  return manifests;
}

export async function listAllNoteSectionEntries(
  engine: BrainEngine,
  scopeId: string,
): Promise<NoteSectionEntry[]> {
  const sections: NoteSectionEntry[] = [];

  for (let offset = 0; ; offset += STRUCTURAL_ENTRY_BATCH_SIZE) {
    const batch = await engine.listNoteSectionEntries({
      scope_id: scopeId,
      limit: STRUCTURAL_ENTRY_BATCH_SIZE,
      offset,
    });
    sections.push(...batch);
    if (batch.length < STRUCTURAL_ENTRY_BATCH_SIZE) {
      break;
    }
  }

  return sections;
}
