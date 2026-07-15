import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export function resolveDreamOutputRoot(brainDir: string, configuredOutputDir: string | null): string {
  const configured = configuredOutputDir?.trim() || 'output';
  return isAbsolute(configured) ? resolve(configured) : resolve(brainDir, configured);
}

export async function ensureDreamOutputDirectory(outputRoot: string): Promise<{ created: boolean; path: string }> {
  const existed = existsSync(outputRoot);
  await mkdir(outputRoot, { recursive: true });
  return { created: !existed, path: outputRoot };
}
