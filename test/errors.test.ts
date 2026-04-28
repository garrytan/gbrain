import { describe, test, expect } from 'bun:test';
import { buildError, errorFor, serializeError, StructuredAgentError } from '../src/core/errors.ts';

describe('buildError', () => {
  test('returns envelope with required fields only', () => {
    const e = buildError({ class: 'FooError', code: 'foo_bar', message: 'something went wrong' });
    expect(e).toEqual({ class: 'FooError', code: 'foo_bar', message: 'something went wrong' });
  });

  test('includes hint when provided', () => {
    const e = buildError({ class: 'X', code: 'y', message: 'm', hint: 'try --foo' });
    expect(e.hint).toBe('try --foo');
  });

  test('includes docs_url when provided', () => {
    const e = buildError({ class: 'X', code: 'y', message: 'm', docs_url: 'https://example.com/docs' });
    expect(e.docs_url).toBe('https://example.com/docs');
  });

  test('omits undefined optional fields from shape', () => {
    const e = buildError({ class: 'X', code: 'y', message: 'm' });
    expect('hint' in e).toBe(false);
    expect('docs_url' in e).toBe(false);
  });
});

describe('StructuredAgentError', () => {
  test('is throwable and catchable as Error', () => {
    try {
      throw errorFor({ class: 'FileTooLarge', code: 'too_big', message: 'file exceeds 10MB' });
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(StructuredAgentError);
    }
  });

  test('carries the structured envelope', () => {
    const err = errorFor({ class: 'X', code: 'y', message: 'z', hint: 'fix it' });
    expect(err.envelope).toEqual({ class: 'X', code: 'y', message: 'z', hint: 'fix it' });
  });

  test('uses class name for Error.name', () => {
    const err = errorFor({ class: 'FooBarError', code: 'x', message: 'y' });
    expect(err.name).toBe('FooBarError');
  });

  test('Error.message composes class + message + hint', () => {
    const err = errorFor({
      class: 'ConfirmationRequired',
      code: 'cost_preview_requires_yes',
      message: 'cost preview requires --yes in non-interactive mode',
      hint: 'pass --yes to proceed',
    });
    expect(err.message).toBe(
      'ConfirmationRequired: cost preview requires --yes in non-interactive mode (pass --yes to proceed)',
    );
  });
});

describe('serializeError', () => {
  test('unwraps StructuredAgentError envelope', () => {
    const err = errorFor({ class: 'A', code: 'b', message: 'c', hint: 'd' });
    expect(serializeError(err)).toEqual({ class: 'A', code: 'b', message: 'c', hint: 'd' });
  });

  test('normalizes plain Error', () => {
    const err = new Error('boom');
    err.name = 'MyError';
    const env = serializeError(err);
    expect(env.class).toBe('MyError');
    expect(env.code).toBe('unknown');
    expect(env.message).toBe('boom');
  });

  test('handles non-Error values', () => {
    const env = serializeError('a string');
    expect(env).toEqual({ class: 'Error', code: 'unknown', message: 'a string' });
  });

  test('handles null/undefined', () => {
    expect(serializeError(null).message).toBe('null');
    expect(serializeError(undefined).message).toBe('undefined');
  });
});
