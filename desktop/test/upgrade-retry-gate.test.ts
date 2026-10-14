import { expect, test } from 'bun:test';
import { runUpgradeRetryGate, startupFailureAllowsRetry } from '../src/main/startup/post-upgrade-startup.js';

test('升级冷备失败时不启动知识库服务', async () => {
  const calls: string[] = [];
  await expect(runUpgradeRetryGate({
    migrationRequired: true,
    migrate: async () => {
      calls.push('migrate');
      throw new Error('PGLite 升级冷备没有返回可验证的备份目录，已停止迁移。');
    },
    reconcile: async () => {
      calls.push('reconcile');
    },
    start: async () => {
      calls.push('start');
    },
  })).rejects.toThrow(/已停止迁移/);
  expect(calls).toEqual(['migrate']);
});

test('不需要升级时直接启动，冷备通过后才启动', async () => {
  const plain: string[] = [];
  await runUpgradeRetryGate({
    migrationRequired: false,
    migrate: async () => {
      plain.push('migrate');
    },
    reconcile: async () => {
      plain.push('reconcile');
    },
    start: async () => {
      plain.push('start');
    },
  });
  expect(plain).toEqual(['reconcile', 'start']);

  const upgraded: string[] = [];
  await runUpgradeRetryGate({
    migrationRequired: true,
    migrate: async () => {
      upgraded.push('migrate');
    },
    reconcile: async () => {
      upgraded.push('reconcile');
    },
    start: async () => {
      upgraded.push('start');
    },
  });
  expect(upgraded).toEqual(['migrate', 'start']);
});

test('启动锁权限失败不再自动重试', () => {
  expect(startupFailureAllowsRetry(
    'FATAL: could not create lock file "postmaster.pid": Permission denied',
  )).toBe(false);
  expect(startupFailureAllowsRetry('数据库目录无法写入启动锁 postmaster.pid，知识库内容没有被修改。')).toBe(false);
  expect(startupFailureAllowsRetry('PMBrain 本地服务尚未就绪。')).toBe(true);
});
