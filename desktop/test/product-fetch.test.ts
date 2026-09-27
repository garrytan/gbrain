import { expect, test } from 'bun:test';
import { productFetch } from '../../admin/src/lib/product-fetch';

test('desktop transport preserves errors and upload bytes without browser fetch', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const requests: any[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { pmbrainDesktop: {
    productRequest: async (request: unknown) => { requests.push(request); return { status: 422, contentType: 'text/plain', body: '原始错误' }; },
  } } });
  try {
    const response = await productFetch('/admin/api/import-upload', { method: 'POST', body: new Blob([new Uint8Array([0, 128, 255])]), headers: { 'Content-Type': 'application/octet-stream' } });
    expect(response.status).toBe(422);
    expect(await response.text()).toBe('原始错误');
    expect(Array.from(requests[0].body)).toEqual([0, 128, 255]);
    expect(requests[0].headers).toEqual({ 'content-type': 'application/octet-stream' });
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
