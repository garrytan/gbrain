import { expect } from 'bun:test';

export async function expectRejection(pending: Promise<unknown>, message?: string | RegExp): Promise<Error> {
  const error = await pending.then(() => null, error => error);
  expect(error).toBeInstanceOf(Error);
  if (typeof message === 'string') expect(error.message).toContain(message);
  else if (message) expect(error.message).toMatch(message);
  return error;
}
