import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ResolvedPack } from './registry.ts';
import { getExtractableSpec } from './extractable.ts';

export interface ResolvedExtractablePrompt {
  page_type: string;
  pack_identity: string;
  declaring_pack: string;
  prompt_path: string;
  prompt_sha256: string;
  prompt: string;
}

function assertSafeRelativePath(value: string): void {
  if (isAbsolute(value)) throw new Error('extractable.prompt_template must be relative');
  const segments = value.split(/[\\/]+/u);
  if (segments.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('extractable.prompt_template contains an unsafe path segment');
  }
}

/**
 * Resolve a pack lens from the pack that supplied the winning page-type
 * declaration. The file is data, never executable code, and every path
 * component must remain a regular, non-symlink descendant of that pack root.
 */
export function resolveExtractablePrompt(
  pack: ResolvedPack,
  pageType: string,
): ResolvedExtractablePrompt | null {
  const spec = getExtractableSpec(pack.manifest, pageType);
  const template = spec?.prompt_template;
  if (!template) return null;
  assertSafeRelativePath(template);

  const origin = pack.page_type_declaration_origins[pageType];
  if (!origin?.manifest_path) {
    throw new Error(`cannot locate declaring pack for extractable page type: ${pageType}`);
  }
  const packRoot = dirname(origin.manifest_path);
  const candidate = resolve(packRoot, template);
  const lexicalRelative = relative(packRoot, candidate);
  if (lexicalRelative.startsWith(`..${sep}`) || lexicalRelative === '..' || isAbsolute(lexicalRelative)) {
    throw new Error('extractable.prompt_template escapes its declaring pack');
  }

  let cursor = packRoot;
  for (const segment of template.split(/[\\/]+/u)) {
    cursor = resolve(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error('extractable.prompt_template may not traverse symlinks');
    }
  }
  if (!lstatSync(candidate).isFile()) {
    throw new Error('extractable.prompt_template must name a regular file');
  }
  const realRoot = realpathSync(packRoot);
  const realCandidate = realpathSync(candidate);
  const realRelative = relative(realRoot, realCandidate);
  if (realRelative.startsWith(`..${sep}`) || realRelative === '..' || isAbsolute(realRelative)) {
    throw new Error('extractable.prompt_template resolves outside its declaring pack');
  }
  const prompt = readFileSync(realCandidate, 'utf8');
  if (prompt.trim().length === 0) throw new Error('extractable.prompt_template is empty');
  return {
    page_type: pageType,
    pack_identity: pack.identity,
    declaring_pack: origin.pack_name,
    prompt_path: template,
    prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
    prompt,
  };
}
