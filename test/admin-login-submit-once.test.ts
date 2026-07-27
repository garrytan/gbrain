import { expect, test } from 'bun:test';
import { createLoginSubmitOnce } from '../admin/src/lib/login-submit-once';

test('coalesces concurrent login submissions and permits retry after a successful settle', async () => {
  let resolveLogin!: () => void;
  let loginCalls = 0;
  const login = () => {
    loginCalls += 1;
    return new Promise<void>(resolve => {
      resolveLogin = resolve;
    });
  };
  const submitLogin = createLoginSubmitOnce(login);

  const first = submitLogin();
  const second = submitLogin();

  expect(loginCalls).toBe(1);
  expect(second).toBe(first);

  resolveLogin();
  await first;

  const third = submitLogin();

  expect(loginCalls).toBe(2);
  expect(third).not.toBe(first);
});

test('permits retry after a failed settle', async () => {
  let rejectLogin!: (error: Error) => void;
  let loginCalls = 0;
  const login = () => {
    loginCalls += 1;
    return new Promise<void>((_resolve, reject) => {
      rejectLogin = reject;
    });
  };
  const submitLogin = createLoginSubmitOnce(login);

  const first = submitLogin();
  rejectLogin(new Error('invalid token'));
  await expect(first).rejects.toThrow('invalid token');

  submitLogin();

  expect(loginCalls).toBe(2);
});
