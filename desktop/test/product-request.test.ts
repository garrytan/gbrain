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
  test('知识页的编码目录和中文身份可以读取正文与分块', () => {
    for (const source of ['default', '资料库']) {
      for (const slug of ['projects/川商出海', 'companies/四川省商务厅', 'sources/项目/申报材料']) {
        const base = `/admin/api/brain/pages/${encodeURIComponent(source)}/${encodeURIComponent(slug)}`;
        for (const suffix of ['', '/chunks?includeDeleted=1', '/delete', '/restore']) {
          const path = base + suffix;
          expect(validateProductRequest({ path }).path).toBe(path);
        }
      }
    }
  });
  test('知识身份放行不能成为路径穿越或其他接口的编码绕过', () => {
    for (const path of [
      '/admin/api/brain/pages/default/projects%2F..%2Fsecret',
      '/admin/api/brain/pages/default/projects%2F%2e%2e%2Fsecret',
      '/admin/api/brain/pages/default/projects%5Csecret',
      '/admin/api/brain/pages/default/projects%2Fsecret%0a',
      '/admin/api/brain/pages/default%2Fother/projects%2Ftest',
      '/admin/api/brain/pages/default/projects%252Ftest',
      '/admin/api/brain/pages/default/projects%2Ftest/arbitrary',
      '/admin/api/brain%2Fpages/default/test',
      '/admin/api/stats%2Fsecret',
      '/admin/api/%69ssue-magic-link',
    ]) expect(() => validateProductRequest({ path })).toThrow();
  });
});
