import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verify, createPublicKey } from 'node:crypto';
import {
  canonicalSendString, checkSendText, generateSendKeyPair, isValidIdempotencyKey, normalizeRecipient, sendKeyPairFromSeed, signSendRequest,
} from '../src/core/apple/send-sign.ts';

const fixture = JSON.parse(readFileSync(join(import.meta.dir, '..', 'apple', 'helper', 'Tests', 'HelperCoreTests', 'Fixtures', 'send-sign-vectors.json'), 'utf8'));

describe('send-sign', () => {
  test('reproduces the vectors the helper verifies', () => {
    const pair = sendKeyPairFromSeed(Buffer.from(fixture.seed_hex, 'hex'));
    expect(pair.publicKey).toBe(fixture.public_key);
    for (const vector of fixture.vectors) {
      expect(canonicalSendString(vector)).toBe(vector.canonical);
      expect(signSendRequest({ privateKey: pair.privateKey, keyName: fixture.key_name, ...vector })).toBe(vector.authorization);
    }
  });

  test('a fresh key pair signs something its public half verifies', () => {
    const pair = generateSendKeyPair();
    const header = signSendRequest({ privateKey: pair.privateKey, keyName: 'box', idempotencyKey: 'abcdefgh', body: '{}', timestamp: 1, nonce: '0'.repeat(32) });
    const sig = Buffer.from(header.split('sig=')[1], 'base64url');
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pair.publicKey }, format: 'jwk' });
    const canonical = canonicalSendString({ timestamp: 1, nonce: '0'.repeat(32), idempotencyKey: 'abcdefgh', body: '{}' });
    expect(verify(null, Buffer.from(canonical), publicKey, sig)).toBe(true);
    expect(verify(null, Buffer.from(canonical + 'x'), publicKey, sig)).toBe(false);
  });

  test('refuses a bad idempotency key or nonce', () => {
    const pair = generateSendKeyPair();
    expect(isValidIdempotencyKey('short')).toBe(false);
    expect(isValidIdempotencyKey('has space here')).toBe(false);
    expect(() => signSendRequest({ privateKey: pair.privateKey, keyName: 'box', idempotencyKey: 'short', body: '{}' })).toThrow();
    expect(() => signSendRequest({ privateKey: pair.privateKey, keyName: 'box', idempotencyKey: 'abcdefgh', body: '{}', nonce: 'ABC' })).toThrow();
  });

  test('counts text the way the helper does', () => {
    expect(checkSendText('hi')).toBeNull();
    expect(checkSendText('')).not.toBeNull();
    expect(checkSendText('   ')).not.toBeNull();
    expect(checkSendText('a'.repeat(2000))).toBeNull();
    expect(checkSendText('a'.repeat(2001))).not.toBeNull();
    expect(checkSendText('👋🏽'.repeat(1000))).toBeNull();
    expect(checkSendText('👋🏽'.repeat(1001))).not.toBeNull();
    expect(checkSendText('a\u0301'.repeat(2000))).toBeNull();
    expect(checkSendText('a\u0301'.repeat(2000) + 'a')).not.toBeNull();
    expect(checkSendText('a\u0301\u0301'.repeat(1500))).not.toBeNull();
  });

  test('normalises recipients the way the helper does', () => {
    expect(normalizeRecipient('+1 (555) 010-0100')).toBe('+15550100100');
    expect(normalizeRecipient(' Test@Example.Invalid ')).toBe('test@example.invalid');
    expect(normalizeRecipient('5550100100')).toBeNull();
    expect(normalizeRecipient('+0123456789')).toBeNull();
    expect(normalizeRecipient('a@b')).toBeNull();
    expect(normalizeRecipient('a"b@example.invalid')).toBeNull();
    expect(normalizeRecipient('\t+15550100 ')).toBe('+15550100');
    expect(normalizeRecipient('+15550100\n')).toBeNull();
    expect(normalizeRecipient('test@example.invalid\n')).toBeNull();
    expect(normalizeRecipient('+155501')).toBeNull();
    expect(normalizeRecipient('+1555010')).toBe('+1555010');
    expect(normalizeRecipient('+155501001001234')).toBe('+155501001001234');
    expect(normalizeRecipient('+1555010010012345')).toBeNull();
    expect(normalizeRecipient('a@b@example.invalid')).toBeNull();
    expect(normalizeRecipient('a@.example.invalid')).toBeNull();
    expect(normalizeRecipient('a@example.invalid.')).toBeNull();
    expect(normalizeRecipient('a'.repeat(250) + '@b.io')).toBeNull();
  });

  test('refuses a seed of the wrong length', () => {
    expect(() => sendKeyPairFromSeed(Buffer.alloc(31))).toThrow();
    expect(() => sendKeyPairFromSeed(Buffer.alloc(33))).toThrow();
  });
});
