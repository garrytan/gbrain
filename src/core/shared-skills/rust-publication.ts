

export function isRustBrain(engine: unknown): boolean {
  return (engine as { kind?: unknown }).kind === 'rust';
}

export interface RustSkillSource { id: string; incarnation: string; archived: boolean; local_path: string | null; aliases: string[] }
