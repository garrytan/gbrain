import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface CodeIndexConfig {
  include: string[];
  exclude: string[];
}

interface RawCodeIndexConfig {
  include?: string[];
  exclude?: string[];
}

const CODE_INDEX_KEYS = new Set(['include', 'exclude']);

function parseCodeIndexYaml(content: string): RawCodeIndexConfig | null {
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));

  let inSection = false;
  let currentList: keyof RawCodeIndexConfig | null = null;
  let sawSection = false;
  const raw: RawCodeIndexConfig = {};

  for (const line of lines) {
    const noComment = line.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (noComment.trim() === '') continue;

    if (!noComment.startsWith(' ') && !noComment.startsWith('\t')) {
      const colon = noComment.indexOf(':');
      if (colon === -1) continue;
      const key = noComment.slice(0, colon).trim();
      if (key === 'code_index' || key === 'code-index') {
        inSection = true;
        sawSection = true;
        currentList = null;
        continue;
      }
      inSection = false;
      currentList = null;
      continue;
    }

    if (!inSection) continue;

    const indented = noComment.replace(/^\s+/, '');

    if (indented.startsWith('-')) {
      if (!currentList) continue;
      const value = indented.slice(1).trim().replace(/^["']|["']$/g, '');
      if (value) {
        if (!raw[currentList]) raw[currentList] = [];
        raw[currentList]!.push(value);
      }
      continue;
    }

    const colon = indented.indexOf(':');
    if (colon === -1) continue;
    const key = indented.slice(0, colon).trim();
    if (CODE_INDEX_KEYS.has(key)) {
      currentList = key as keyof RawCodeIndexConfig;
      const remainder = indented.slice(colon + 1).trim();
      if (remainder === '[]' && !raw[currentList]) {
        raw[currentList] = [];
      }
      continue;
    }
    currentList = null;
  }

  if (!sawSection) return null;
  return raw;
}

export function loadCodeIndexConfig(repoPath?: string | null): CodeIndexConfig | null {
  if (!repoPath) return null;

  const yamlPath = join(repoPath, 'gbrain.yml');
  if (!existsSync(yamlPath)) return null;

  const content = readFileSync(yamlPath, 'utf-8');
  const raw = parseCodeIndexYaml(content);
  if (raw === null) return null;

  return {
    include: raw.include ?? [],
    exclude: raw.exclude ?? [],
  };
}
