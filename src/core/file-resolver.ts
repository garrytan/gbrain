import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { parse as parseYaml } from './yaml-lite.ts';
import type { StorageBackend } from './storage.ts';

/**
 * Universal file reader with fallback chain:
 * 1. Local file exists → return it
 * 2. .redirect breadcrumb exists → fetch from storage
 * 3. .supabase marker in parent dir → prefer storage, fall back to local
 * 4. None → throw
 */

export interface ResolvedFile {
  data: Buffer;
  source: 'local' | 'storage' | 'redirect';
}

export interface RedirectInfo {
  moved_to: string;
  bucket: string;
  path: string;
  moved_at: string;
  original_hash: string;
}

export interface MarkerInfo {
  synced_at: string;
  bucket: string;
  prefix: string;
  file_count: number;
}

export async function resolveFile(
  filePath: string,
  brainRoot: string,
  storage?: StorageBackend,
): Promise<ResolvedFile> {
  const { resolve: resolvePath } = await import('path');
  const resolvedRoot = resolvePath(brainRoot);
  const resolvedFull = resolvePath(brainRoot, filePath);
  if (!resolvedFull.startsWith(resolvedRoot + '/') && resolvedFull !== resolvedRoot) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside brain root`);
  }

  const fullPath = join(brainRoot, filePath);

  // 1. Local file exists
  if (existsSync(fullPath)) {
    return { data: readFileSync(fullPath), source: 'local' };
  }

  // 2. .redirect breadcrumb
  const redirectPath = fullPath + '.redirect';
  if (existsSync(redirectPath)) {
    if (!storage) throw new Error(`File redirected to storage but no storage backend configured: ${filePath}`);
    const info = parseRedirect(redirectPath);
    const data = await storage.download(info.path);
    return { data, source: 'redirect' };
  }

  // 3. .supabase marker in parent directory
  const markerPath = join(dirname(fullPath), '.supabase');
  if (existsSync(markerPath)) {
    if (!storage) throw new Error(`Directory mirrored to storage but no storage backend configured: ${filePath}`);
    const marker = parseMarker(markerPath);
    if (marker.prefix) {
      if (/\.\.[\\/]/.test(marker.prefix) || marker.prefix === '..' || marker.prefix.startsWith('/')) {
        throw new Error(`Blocked: .supabase marker prefix contains path traversal: ${marker.prefix}`);
      }
    }
    const filename = filePath.split('/').pop() || '';
    if (/\.\.[\\/]/.test(filename) || filename === '..' || filename.startsWith('/')) {
      throw new Error(`Blocked: filename contains path traversal: ${filename}`);
    }
    const storagePath = (marker.prefix || '') + filename;
    try {
      const data = await storage.download(storagePath);
      return { data, source: 'storage' };
    } catch {
      // Fall back to local if storage fails and local exists
      if (existsSync(fullPath)) {
        return { data: readFileSync(fullPath), source: 'local' };
      }
      throw new Error(`File not found locally or in storage: ${filePath}`);
    }
  }

  throw new Error(`File not found: ${filePath}`);
}

export function parseRedirect(path: string): RedirectInfo {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content) as unknown as RedirectInfo;
}

export function parseMarker(path: string): MarkerInfo {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content) as unknown as MarkerInfo;
}
