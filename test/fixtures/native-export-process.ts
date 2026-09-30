import { nativeExportPublisher } from '../../src/core/persistence/native-lock.ts';

const publisher = await nativeExportPublisher();
try {
  const handle = publisher.beginExport(process.argv[2]!);
  if (process.argv[3] === 'publish') {
    publisher.publishExportFile(handle, 'data', Buffer.alloc(4096, 42));
    publisher.completeExport(handle);
    publisher.closeExport(handle);
  }
} catch {
  process.exit(2);
}
