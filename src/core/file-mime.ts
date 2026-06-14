import { extname } from 'path';

const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.heic': 'image/heic',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.dng': 'image/x-adobe-dng',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ACTIVE_CONTENT_EXTENSIONS = new Set(['.htm', '.html', '.svg', '.svgz']);

export function detectMimeType(filePath: string, content?: Uint8Array): string | null {
  const sniffed = content ? sniffMimeType(content) : null;
  if (sniffed) return sniffed;
  const extension = extname(filePath).toLowerCase();
  if (ACTIVE_CONTENT_EXTENSIONS.has(extension)) return 'application/octet-stream';
  return EXTENSION_MIME_TYPES[extension] || null;
}

function sniffMimeType(content: Uint8Array): string | null {
  if (content.length >= 4) {
    if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
    if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47) return 'image/png';
    if (content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44 && content[3] === 0x46) return 'application/pdf';
  }
  const header = Buffer.from(content.subarray(0, Math.min(content.length, 512))).toString('utf8').trimStart().toLowerCase();
  if (header.startsWith('gif87a') || header.startsWith('gif89a')) return 'image/gif';
  if (content.length >= 12
    && Buffer.from(content.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(content.subarray(8, 12)).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (header.startsWith('<svg') || header.startsWith('<?xml') || header.startsWith('<!doctype html') || header.startsWith('<html')) {
    return 'application/octet-stream';
  }
  return null;
}
