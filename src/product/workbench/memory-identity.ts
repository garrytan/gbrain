import { createHash } from 'node:crypto';
import type { WorkbenchMessage } from '../../../shared/workbench';

export function memoryVersion(message: WorkbenchMessage) {
  return createHash('sha256').update(JSON.stringify([message.text, (message.attachments ?? []).map(item => item.id)])).digest('hex');
}
