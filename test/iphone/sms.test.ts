import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  IPhoneBackupManifest,
  SMS_DOMAIN,
  SMS_RELATIVE_PATH,
} from '../../src/core/iphone/manifest.ts';
import { APPLE_EPOCH_MS, openSmsDb, parseAppleMessageDate, readSmsMessages, segmentMessagesByMonth } from '../../src/core/iphone/sms.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'iphone-backup', 'backup');

function smsPath(): string {
  const manifest = new IPhoneBackupManifest(FIXTURE);
  const ref = manifest.resolveFile(SMS_DOMAIN, SMS_RELATIVE_PATH);
  manifest.close();
  if (!ref) throw new Error('fixture sms DB missing');
  return ref.path;
}

describe('iPhone sms.db reader', () => {
  test('converts Apple message dates in nanoseconds and seconds', () => {
    const iso = '2024-03-15T09:00:00.000Z';
    const seconds = (Date.parse(iso) - APPLE_EPOCH_MS) / 1000;
    const nanos = seconds * 1_000_000_000;

    expect(parseAppleMessageDate(seconds).toISOString()).toBe(iso);
    expect(parseAppleMessageDate(nanos).toISOString()).toBe(iso);
  });

  test('rejects numeric dates outside the JavaScript Date range', () => {
    expect(() => parseAppleMessageDate(Number.MAX_VALUE)).toThrow('outside supported range');
  });

  test('reads messages with handle, chat, sender, and service fields', () => {
    const db = openSmsDb(smsPath());
    const messages = readSmsMessages(db);
    db.close?.();

    expect(messages).toHaveLength(6);
    expect(messages[0]).toMatchObject({
      id: 100,
      chatId: 7,
      handle: '+15550000001',
      isFromMe: true,
      service: 'iMessage',
      text: 'did acme-example wire the invoice?',
    });
    expect(messages[1].timestamp.toISOString()).toBe('2024-03-15T09:02:00.000Z');
  });

  test('segments messages by chat and month', () => {
    const db = openSmsDb(smsPath());
    const segments = segmentMessagesByMonth(readSmsMessages(db));
    db.close?.();

    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.month)).toEqual(['2024-03', '2024-04']);
    expect(segments[0].participantHandles).toEqual(['+15550000001']);
    expect(segments[0].messages).toHaveLength(3);
  });
});
