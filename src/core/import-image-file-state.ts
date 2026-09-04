import { basename, extname } from 'node:path';
import type { BrainEngine, FileSpec } from './engine.ts';
import { clearImportedPageImageHead, reconcileImportedPageImage } from './import-transaction.ts';
import { NATIVE_IMAGE_MAX_BYTES } from './native-image-result.ts';
import { sniffContentType } from './search/image-loader.ts';

/** Build metadata only for original bytes the native MCP image carrier accepts. */
export function nativeGitImageFileSpec(input: {
  sourceId: string;
  relativePath: string;
  bytes: Buffer;
  decodedMime: string;
  contentHash: string;
}): { filename: string; file?: FileSpec } {
  const filename = basename(input.relativePath);
  const gitPath = input.relativePath.replace(/[\\\/]/g, '/');
  const nativeExtension = ['.png', '.jpg', '.jpeg', '.webp']
    .includes(extname(input.relativePath).toLowerCase());
  let nativeMime: string | null = null;
  if (nativeExtension && input.bytes.length <= NATIVE_IMAGE_MAX_BYTES) {
    try {
      const sniffed = sniffContentType(input.bytes);
      if (sniffed === input.decodedMime) nativeMime = sniffed;
    } catch { /* searchable image import stays valid without an MCP head */ }
  }
  return {
    filename,
    ...(nativeMime ? {
      file: {
        filename,
        storage_path: `git/${input.sourceId}/${gitPath}`,
        mime_type: nativeMime,
        size_bytes: input.bytes.length,
        content_hash: input.contentHash,
        metadata: { storage: 'git', kind: 'page_image', alt_text: filename, git_path: gitPath },
      },
    } : {}),
  };
}

export async function reconcileUnchangedImportedImage(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  filename: string,
  file?: FileSpec,
): Promise<void> {
  if (file) await reconcileImportedPageImage(engine, slug, sourceId, file);
  else await clearImportedPageImageHead(engine, slug, sourceId, filename);
}
