interface DesktopProductBridge {
  productRequest(request: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }): Promise<{ status: number; body: string; contentType: string }>;
}

export function desktopApi(): (DesktopProductBridge & Record<string, any>) | undefined {
  return (window as unknown as { pmbrainDesktop?: DesktopProductBridge & Record<string, any> }).pmbrainDesktop;
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
