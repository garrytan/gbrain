import type { PMBrainDesktopApi } from '../../../desktop/src/preload/index';

export function desktopApi(): PMBrainDesktopApi | undefined {
  return (window as unknown as { pmbrainDesktop?: PMBrainDesktopApi }).pmbrainDesktop;
}

export async function productFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const desktop = desktopApi();
  if (!desktop) return fetch(path, options);
  let body: string | Uint8Array | undefined;
  if (typeof options.body === 'string') body = options.body;
  else if (options.body instanceof Blob) body = new Uint8Array(await options.body.arrayBuffer());
  else if (options.body != null) throw new Error('不支持的工作台请求内容');
  const result = await desktop.productRequest({
    path,
    method: options.method,
    headers: Object.fromEntries(new Headers(options.headers).entries()),
    body,
  });
  return new Response(result.status === 204 ? null : result.body, { status: result.status, headers: { 'Content-Type': result.contentType } });
}
