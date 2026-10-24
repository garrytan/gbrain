import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import { S3Storage } from '../src/core/storage/s3.ts';
import { hashStorageFile, uploadStorageFile } from '../src/core/storage.ts';

test('originals upload in bounded parts with matching hashes and abort on failure', async () => {
  const dir = mkdtempSync(join(import.meta.dir, '.s3-original-'));
  const file = join(dir, 'original.bin');
  const chunk = Buffer.alloc(1024 * 1024, 73);
  const expected = createHash('sha256');
  const size = 33 * chunk.length + 19;
  try {
    writeFileSync(file, '');
    const { appendFileSync } = await import('fs');
    for (let i = 0; i < 33; i++) {
      appendFileSync(file, chunk);
      expected.update(chunk);
    }
    appendFileSync(file, chunk.subarray(0, 19));
    expected.update(chunk.subarray(0, 19));
    const digest = expected.digest('hex');
    expect(hashStorageFile(file)).toBe(digest);

    for (const fail of [false, true]) {
      const commands: any[] = [];
      const received = createHash('sha256');
      let total = 0;
      const storage = new S3Storage({ backend: 's3', bucket: 'originals' }, {
        send: async (command: any) => {
          commands.push(command);
          expect(command.input.Bucket).toBe('originals');
          expect(command.input.Key).toBe('media/original.bin');
          if (command instanceof CreateMultipartUploadCommand) {
            expect(command.input.ContentType).toBe('video/mp4');
            return { UploadId: 'upload-id' };
          }
          if (command instanceof UploadPartCommand) {
            const input = command.input;
            const body = input.Body as Buffer;
            expect(input.UploadId).toBe('upload-id');
            expect(body.length).toBeLessThanOrEqual(16 * 1024 * 1024);
            expect(input.ContentLength).toBe(body.length);
            if (fail && input.PartNumber === 2) throw new Error('part rejected');
            received.update(body);
            total += body.length;
            return { ETag: 'part-' + input.PartNumber };
          }
          if (command instanceof PutObjectCommand) throw new Error('original buffered');
          return {};
        },
      } as unknown as S3Client);
      const result = uploadStorageFile(storage, 'media/original.bin', file, 'video/mp4');
      if (fail) {
        await expect(result).rejects.toThrow('part rejected');
        expect(commands.at(-1)).toBeInstanceOf(AbortMultipartUploadCommand);
        expect(commands.at(-1).input.UploadId).toBe('upload-id');
        expect(commands.some(c => c instanceof CompleteMultipartUploadCommand)).toBe(false);
      } else {
        await result;
        expect(total).toBe(size);
        expect(received.digest('hex')).toBe(digest);
        expect(commands.at(-1)).toBeInstanceOf(CompleteMultipartUploadCommand);
        expect(commands.at(-1).input.MultipartUpload.Parts).toEqual([
          { PartNumber: 1, ETag: 'part-1' },
          { PartNumber: 2, ETag: 'part-2' },
          { PartNumber: 3, ETag: 'part-3' },
        ]);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

