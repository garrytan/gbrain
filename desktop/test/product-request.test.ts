import { describe, expect, test } from 'bun:test';
import { validateProductRequest } from '../src/main/product-request.js';

describe('统一工作台请求边界', () => {
  test('允许同一个本地服务的知识查询与文件上传', () => {
    expect(validateProductRequest({ path: '/admin/api/brain/overview' }).method).toBe('GET');
    expect(validateProductRequest({ path: '/admin/api/import-upload', method: 'POST', body: new Uint8Array([1]), headers: { 'Content-Type': 'application/octet-stream' } }).method).toBe('POST');
  });
  test('拒绝外部地址、路径穿越和认证管理入口', () => {
    for (const path of ['https://example.com/admin/api/stats', '//example.com/admin/api/stats', '/admin/api/../login', '/admin/api/%2e%2e/login', '/admin/login', '/admin/api/issue-magic-link', '/admin/api/stats#x']) {
      expect(() => validateProductRequest({ path })).toThrow();
    }
  });
  test('调用方不能注入认证头或任意 HTTP 方法', () => {
    expect(() => validateProductRequest({ path: '/admin/api/stats', headers: { Cookie: 'test' } })).toThrow();
    expect(() => validateProductRequest({ path: '/admin/api/stats', method: 'CONNECT' })).toThrow();
  });
});
