export interface ProductRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

export interface ProductResponse {
  status: number;
  contentType: string;
  body: string;
}

export function validateProductRequest(input: ProductRequest): ProductRequest & { method: string } {
  if (!input || typeof input.path !== 'string') throw new Error('无效的工作台请求');
  const path = input.path;
  const decoded = decodeURIComponent(path.split('?')[0]);
  if (!path.startsWith('/admin/api/') || /[\\#\r\n]/.test(path)
    || decoded.split('/').some(part => part === '.' || part === '..')
    || /%(?:2f|5c|25)/i.test(path.split('?')[0])
    || decoded === '/admin/api/issue-magic-link') throw new Error('不允许的工作台请求路径');
  const method = input.method ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('不允许的请求方法');
  for (const name of Object.keys(input.headers ?? {})) {
    if (!['content-type', 'x-pmbrain-filename'].includes(name.toLowerCase())) throw new Error('不允许的请求头');
  }
  if (input.body !== undefined && typeof input.body !== 'string' && !(input.body instanceof Uint8Array)) throw new Error('无效的请求内容');
  return { ...input, method };
}
