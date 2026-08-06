import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import type { RedirectHop } from "./types.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_QUERY_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "credential",
  "key",
  "password",
  "secret",
  "signature",
  "token",
]);

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const IPV4_MAPPED_ADDRESSES = new BlockList();
IPV4_MAPPED_ADDRESSES.addSubnet("::ffff:0:0", 96, "ipv6");

export interface BoundedHttpPolicy {
  allowed_hosts: readonly string[];
  max_bytes: number;
  timeout_ms: number;
  max_redirects: number;
  user_agent?: string;
}

export type HttpFetch = (
  input: string | URL | Request,
  init: RequestInit | undefined,
  pinnedAddress: string,
) => Promise<Response>;

export interface HttpClientDependencies {
  fetch?: HttpFetch;
  resolve?: (hostname: string) => Promise<readonly string[]>;
  clock?: () => Date;
}

export interface HttpFetchOptions {
  max_bytes?: number;
}

export interface HttpAcquisitionResult {
  content: Uint8Array;
  requested_uri: string;
  final_uri: string;
  media_type: string;
  redirects: RedirectHop[];
  started_at: string;
  acquired_at: string;
}

export interface HttpAcquisitionErrorInput {
  code: string;
  requested_uri: string;
  final_uri: string;
  redirects: readonly RedirectHop[];
}

export class HttpAcquisitionError extends Error {
  readonly code: string;
  readonly requested_uri: string;
  readonly final_uri: string;
  readonly redirects: RedirectHop[];

  constructor(input: HttpAcquisitionErrorInput) {
    super(`HTTP acquisition failed: ${input.code}`);
    this.name = "HttpAcquisitionError";
    this.code = input.code;
    this.requested_uri = input.requested_uri;
    this.final_uri = input.final_uri;
    this.redirects = input.redirects.map((redirect) => ({ ...redirect }));
  }
}

function normalizeMediaType(value: string | null): string | null {
  if (!value) return null;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) return null;
  return mediaType;
}

function isSensitiveQueryParameter(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_QUERY_NAMES.has(normalized) || /(?:token|secret|signature|password|credential)$/.test(normalized);
}

function redactUriForJournal(value: string): string {
  try {
    const uri = new URL(value);
    uri.username = "";
    uri.password = "";
    uri.search = "";
    uri.hash = "";
    return uri.toString();
  } catch {
    return "https://invalid.invalid/";
  }
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_ADDRESSES.check(address, "ipv4");
  if (family === 6) {
    return !IPV4_MAPPED_ADDRESSES.check(address, "ipv6") && !NON_PUBLIC_ADDRESSES.check(address, "ipv6");
  }
  return false;
}

function positiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${field} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

const pinnedHttpsFetch: HttpFetch = async (input, init = {}, pinnedAddress) => {
  const uri = new URL(String(input));
  const family = isIP(pinnedAddress);
  if (family === 0) throw new TypeError("pinnedAddress must be an IP address");
  const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, pinnedAddress, family);
  };
  const headers = Object.fromEntries(new Headers(init.headers).entries());

  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(uri, {
      method: init.method ?? "GET",
      headers,
      signal: init.signal ?? undefined,
      servername: uri.hostname,
      lookup: pinnedLookup,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, value);
        }
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          incoming.on("data", (chunk: Buffer | Uint8Array | string) => {
            controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
          });
          incoming.on("end", () => controller.close());
          incoming.on("error", (error) => controller.error(error));
        },
        cancel() {
          incoming.destroy();
        },
      });
      resolve(new Response(body, {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.on("error", reject);
    request.end();
  });
};

export class BoundedHttpClient {
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly fetchImpl: HttpFetch;
  private readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  private readonly clock: () => Date;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly userAgent: string;

  constructor(policy: BoundedHttpPolicy, dependencies: HttpClientDependencies = {}) {
    const hosts = policy.allowed_hosts.map((host) => host.trim().toLowerCase());
    if (hosts.length === 0 || hosts.some((host) => !host || host.includes("/") || host.includes("@") || host.includes(":"))) {
      throw new TypeError("allowed_hosts must contain plain hostnames without ports or credentials");
    }
    this.allowedHosts = new Set(hosts);
    this.maxBytes = positiveInteger(policy.max_bytes, "max_bytes", 512 * 1024 * 1024);
    this.timeoutMs = positiveInteger(policy.timeout_ms, "timeout_ms", 120_000);
    if (!Number.isSafeInteger(policy.max_redirects) || policy.max_redirects < 0 || policy.max_redirects > 10) {
      throw new TypeError("max_redirects must be an integer between 0 and 10");
    }
    this.maxRedirects = policy.max_redirects;
    this.userAgent = policy.user_agent?.trim() || "gbrain-coe-snapshot/1.0";
    this.fetchImpl = dependencies.fetch ?? pinnedHttpsFetch;
    this.resolveHost = dependencies.resolve ?? (async (hostname) => {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      return addresses.map(({ address }) => address);
    });
    this.clock = dependencies.clock ?? (() => new Date());
  }

  private error(
    code: string,
    requestedUri: string,
    finalUri: string,
    redirects: readonly RedirectHop[],
  ): HttpAcquisitionError {
    return new HttpAcquisitionError({
      code,
      requested_uri: requestedUri,
      final_uri: finalUri,
      redirects,
    });
  }

  private normalizeUri(
    value: string | URL,
    requestedUri: string,
    currentUri: string,
    redirects: readonly RedirectHop[],
  ): URL {
    let uri: URL;
    try {
      uri = value instanceof URL ? new URL(value) : new URL(value);
    } catch {
      throw this.error("invalid_uri", requestedUri, currentUri, redirects);
    }
    if (uri.protocol !== "https:") throw this.error("scheme_not_allowed", requestedUri, currentUri, redirects);
    if (uri.username || uri.password) throw this.error("credentials_forbidden", requestedUri, currentUri, redirects);
    if (uri.port && uri.port !== "443") throw this.error("port_not_allowed", requestedUri, currentUri, redirects);
    const hostname = uri.hostname.toLowerCase();
    if (!this.allowedHosts.has(hostname)) throw this.error("host_not_allowed", requestedUri, currentUri, redirects);
    for (const key of uri.searchParams.keys()) {
      if (isSensitiveQueryParameter(key)) {
        throw this.error("sensitive_query_parameter", requestedUri, currentUri, redirects);
      }
    }
    uri.hash = "";
    return uri;
  }

  private async resolvePublicAddress(
    uri: URL,
    requestedUri: string,
    redirects: readonly RedirectHop[],
  ): Promise<string> {
    const directFamily = isIP(uri.hostname);
    let addresses: readonly string[];
    try {
      addresses = directFamily > 0 ? [uri.hostname] : await this.resolveHost(uri.hostname);
    } catch {
      throw this.error("dns_resolution_failed", requestedUri, uri.toString(), redirects);
    }
    if (addresses.length === 0) throw this.error("dns_no_addresses", requestedUri, uri.toString(), redirects);
    if (addresses.some((address) => !isPublicAddress(address))) {
      throw this.error("non_public_address", requestedUri, uri.toString(), redirects);
    }
    return addresses[0]!;
  }

  private async readBody(
    response: Response,
    maxBytes: number,
    requestedUri: string,
    currentUri: string,
    redirects: readonly RedirectHop[],
  ): Promise<Buffer> {
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      if (!/^\d+$/.test(rawLength)) throw this.error("invalid_content_length", requestedUri, currentUri, redirects);
      if (Number(rawLength) > maxBytes) throw this.error("response_too_large", requestedUri, currentUri, redirects);
    }
    if (!response.body) throw this.error("missing_response_body", requestedUri, currentUri, redirects);

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw this.error("response_too_large", requestedUri, currentUri, redirects);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  }

  async fetch(uri: string, options: HttpFetchOptions = {}): Promise<HttpAcquisitionResult> {
    const startedAt = this.clock().toISOString();
    const maxBytes = options.max_bytes === undefined
      ? this.maxBytes
      : positiveInteger(options.max_bytes, "max_bytes", this.maxBytes);
    const redirects: RedirectHop[] = [];
    const journalSafeInitialUri = redactUriForJournal(uri);
    const initial = this.normalizeUri(uri, journalSafeInitialUri, journalSafeInitialUri, redirects);
    const requestedUri = initial.toString();
    let current = initial;

    while (true) {
      const pinnedAddress = await this.resolvePublicAddress(current, requestedUri, redirects);
      const currentUri = current.toString();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/pdf,text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
            "user-agent": this.userAgent,
          },
        }, pinnedAddress);

        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirects.length >= this.maxRedirects) {
            throw this.error("too_many_redirects", requestedUri, currentUri, redirects);
          }
          const location = response.headers.get("location");
          if (!location) throw this.error("redirect_missing_location", requestedUri, currentUri, redirects);
          let candidate: URL;
          try {
            candidate = new URL(location, current);
          } catch {
            throw this.error("invalid_redirect_uri", requestedUri, currentUri, redirects);
          }
          const next = this.normalizeUri(candidate, requestedUri, currentUri, redirects);
          redirects.push({ from_uri: currentUri, to_uri: next.toString(), status_code: response.status });
          await response.body?.cancel();
          current = next;
          continue;
        }

        if (response.status < 200 || response.status >= 300) {
          throw this.error(`http_status_${response.status}`, requestedUri, currentUri, redirects);
        }
        const mediaType = normalizeMediaType(response.headers.get("content-type"));
        if (!mediaType) throw this.error("missing_or_invalid_content_type", requestedUri, currentUri, redirects);
        const content = await this.readBody(response, maxBytes, requestedUri, currentUri, redirects);
        return {
          content,
          requested_uri: requestedUri,
          final_uri: currentUri,
          media_type: mediaType,
          redirects,
          started_at: startedAt,
          acquired_at: this.clock().toISOString(),
        };
      } catch (error) {
        if (error instanceof HttpAcquisitionError) throw error;
        if (controller.signal.aborted) throw this.error("timeout", requestedUri, currentUri, redirects);
        throw this.error("network_error", requestedUri, currentUri, redirects);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}
