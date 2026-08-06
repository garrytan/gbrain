import { describe, expect, test } from "bun:test";

import {
  BoundedHttpClient,
  HttpAcquisitionError,
  type HttpClientDependencies,
} from "../src/coe/registry/index.ts";

const PUBLIC_ADDRESSES = async () => ["93.184.216.34"];

function client(
  fetchImpl: HttpClientDependencies["fetch"],
  overrides: Partial<ConstructorParameters<typeof BoundedHttpClient>[0]> = {},
  resolve = PUBLIC_ADDRESSES,
): BoundedHttpClient {
  return new BoundedHttpClient(
    {
      allowed_hosts: ["example.com", "cdn.example.com"],
      max_bytes: 32,
      timeout_ms: 1_000,
      max_redirects: 2,
      ...overrides,
    },
    {
      fetch: fetchImpl,
      resolve,
      clock: () => new Date("2026-08-04T12:00:00.000Z"),
    },
  );
}

describe("CoE bounded HTTP acquisition", () => {
  test("follows only validated redirects and returns exact response bytes", async () => {
    const calls: string[] = [];
    const fetchImpl: HttpClientDependencies["fetch"] = async (input, init) => {
      const uri = String(input);
      calls.push(uri);
      expect(init?.redirect).toBe("manual");
      if (uri === "https://example.com/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/final" },
        });
      }
      return new Response("<!doctype html><html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const result = await client(fetchImpl).fetch("https://example.com/start");

    expect(calls).toEqual(["https://example.com/start", "https://cdn.example.com/final"]);
    expect(result.requested_uri).toBe("https://example.com/start");
    expect(result.final_uri).toBe("https://cdn.example.com/final");
    expect(result.media_type).toBe("text/html");
    expect(Buffer.from(result.content).toString("utf8")).toBe("<!doctype html><html>ok</html>");
    expect(result.redirects).toEqual([
      {
        from_uri: "https://example.com/start",
        to_uri: "https://cdn.example.com/final",
        status_code: 302,
      },
    ]);
  });

  test("rejects unsafe URI shapes before fetch", async () => {
    let called = false;
    const fetchImpl: HttpClientDependencies["fetch"] = async () => {
      called = true;
      return new Response("unexpected");
    };
    const bounded = client(fetchImpl);

    const cases: Array<[string, string]> = [
      ["http://example.com/file", "scheme_not_allowed"],
      ["https://user:password@example.com/file", "credentials_forbidden"],
      ["https://example.com:8443/file", "port_not_allowed"],
      ["https://evil.example/file", "host_not_allowed"],
      ["https://example.com/file?access_token=secret", "sensitive_query_parameter"],
    ];
    for (const [uri, code] of cases) {
      await expect(bounded.fetch(uri)).rejects.toMatchObject({ code });
    }
    const sensitive = await bounded.fetch("https://example.com/file?access_token=do-not-store").catch((error) => error);
    expect(sensitive).toMatchObject({
      code: "sensitive_query_parameter",
      requested_uri: "https://example.com/file",
      final_uri: "https://example.com/file",
    });
    expect(JSON.stringify(sensitive)).not.toContain("do-not-store");
    expect(called).toBe(false);
  });

  test("rejects private or reserved DNS answers", async () => {
    const bounded = client(async () => new Response("unexpected"), {}, async () => ["127.0.0.1"]);
    await expect(bounded.fetch("https://example.com/file")).rejects.toMatchObject({ code: "non_public_address" });
  });

  test("rejects every IPv4-mapped IPv6 DNS answer", async () => {
    for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:93.184.216.34"]) {
      const bounded = client(async () => new Response("unexpected"), {}, async () => [address]);
      await expect(bounded.fetch("https://example.com/file")).rejects.toMatchObject({ code: "non_public_address" });
    }
  });

  test("pins the transport to the exact public address that passed validation", async () => {
    const pinnedAddresses: Array<string | undefined> = [];
    const fetchImpl = (async (_input: string | URL | Request, _init?: RequestInit, pinnedAddress?: string) => {
      pinnedAddresses.push(pinnedAddress);
      return new Response("pinned", { headers: { "content-type": "text/plain" } });
    }) as HttpClientDependencies["fetch"];

    await client(fetchImpl, {}, async () => ["93.184.216.34"]).fetch("https://example.com/file");

    expect(pinnedAddresses).toEqual(["93.184.216.34"]);
  });

  test("enforces both advertised and streamed byte limits", async () => {
    const advertised = client(async () => new Response("small", {
      headers: {
        "content-type": "text/plain",
        "content-length": "999",
      },
    }));
    await expect(advertised.fetch("https://example.com/file")).rejects.toMatchObject({
      code: "response_too_large",
    });

    const streamed = client(async () => new Response("x".repeat(33), {
      headers: { "content-type": "text/plain" },
    }));
    await expect(streamed.fetch("https://example.com/file")).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  test("maps HTTP and timeout failures to stable journal-safe error codes", async () => {
    const unavailable = client(async () => new Response("maintenance", {
      status: 503,
      headers: { "content-type": "text/plain" },
    }));
    await expect(unavailable.fetch("https://example.com/file")).rejects.toMatchObject({
      code: "http_status_503",
      final_uri: "https://example.com/file",
    });

    const timedOut = client(
      async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
      { timeout_ms: 5 },
    );
    await expect(timedOut.fetch("https://example.com/file")).rejects.toMatchObject({ code: "timeout" });
  });

  test("applies timeout_ms to DNS resolution", async () => {
    const dnsStall = client(
      async () => {
        throw new Error("fetch must not run while DNS is unresolved");
      },
      { timeout_ms: 5 },
      async () => await new Promise<string[]>(() => {}),
    );

    const outcome = await Promise.race([
      dnsStall.fetch("https://example.com/file")
        .then(() => "resolved")
        .catch((error: HttpAcquisitionError) => error.code),
      new Promise<string>((resolve) => setTimeout(() => resolve("still_pending"), 50)),
    ]);

    expect(outcome).toBe("timeout");
  });

  test("uses one timeout budget across every redirect hop", async () => {
    let calls = 0;
    const redirectStall = client(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        calls += 1;
        return calls <= 10
          ? new Response(null, {
            status: 302,
            headers: { location: `https://example.com/hop-${calls}` },
          })
          : new Response("ok", { headers: { "content-type": "text/plain" } });
      },
      { timeout_ms: 60, max_redirects: 10 },
    );

    await expect(redirectStall.fetch("https://example.com/start")).rejects.toMatchObject({ code: "timeout" });
  });

  test("applies timeout_ms while streaming the response body", async () => {
    let transportAborted = false;
    const bodyStall = client(
      async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          transportAborted = true;
        });
        return new Response(new ReadableStream<Uint8Array>({
          start() {},
        }), {
          headers: { "content-type": "text/plain" },
        });
      },
      { timeout_ms: 5 },
    );

    const outcome = await Promise.race([
      bodyStall.fetch("https://example.com/file")
        .then(() => "resolved")
        .catch((error: HttpAcquisitionError) => error.code),
      new Promise<string>((resolve) => setTimeout(() => resolve("still_pending"), 50)),
    ]);

    expect(outcome).toBe("timeout");
    expect(transportAborted).toBe(true);
  });

  test("does not let stalled body cancellation hide a byte-limit failure", async () => {
    const cancellationStall = client(
      async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
        },
        cancel: async () => await new Promise<void>(() => {}),
      }), {
        headers: { "content-type": "application/octet-stream" },
      }),
      { max_bytes: 1, timeout_ms: 5 },
    );

    const outcome = await Promise.race([
      cancellationStall.fetch("https://example.com/file")
        .then(() => "resolved")
        .catch((error: HttpAcquisitionError) => error.code),
      new Promise<string>((resolve) => setTimeout(() => resolve("still_pending"), 50)),
    ]);

    expect(outcome).toBe("response_too_large");
  });

  test("error objects retain only bounded redirect context", () => {
    const error = new HttpAcquisitionError({
      code: "network_error",
      requested_uri: "https://example.com/start",
      final_uri: "https://example.com/final",
      redirects: [],
    });
    expect(error.message).toBe("HTTP acquisition failed: network_error");
    expect(error.name).toBe("HttpAcquisitionError");
  });
});
