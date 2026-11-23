import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';

export function readPrivateAuditJson(path: string, maxBytes: number): unknown {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > maxBytes ||
        (process.getuid !== undefined && (file.uid !== process.getuid() || (file.mode & 0o077) !== 0))) {
      throw new Error('Expected a bounded, owner-only regular audit file');
    }
    const data = Buffer.alloc(file.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const bytes = readSync(fd, data, offset, data.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset !== file.size) throw new Error('Audit file changed during the read');
    return JSON.parse(data.subarray(0, offset).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}
