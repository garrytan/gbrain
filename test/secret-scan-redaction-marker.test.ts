import { describe, expect, test } from 'bun:test';
import { labeledValueIsCredential } from '../src/core/secret-scan-labeled.ts';

describe('labeled credential redaction markers', () => {
  test('does not treat the tail of an importer marker as a pair password', () => {
    const result = labeledValueIsCredential('user-pattern>**', 'pair', ' login **<REDACTED:');
    expect(result).toBe(false);
  });
});
