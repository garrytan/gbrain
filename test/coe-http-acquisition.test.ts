import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
      allowed_hosts: ["example.com", "cdn.example.com", "api.github.com"],
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

  test("keeps transport queries but exposes only allowlisted query parameters for journaling", async () => {
    const calls: string[] = [];
    const bounded = client(async (input) => {
      const uri = String(input);
      calls.push(uri);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://api.github.com/repos/acme/example/git/trees/final?recursive=0&opaque_redirect=redirect-secret",
          },
        });
      }
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    });

    const result = await bounded.fetch(
      "https://api.github.com/repos/acme/example/git/trees/start?recursive=1&opaque_request=request-secret",
    );

    expect(calls).toEqual([
      "https://api.github.com/repos/acme/example/git/trees/start?recursive=1&opaque_request=request-secret",
      "https://api.github.com/repos/acme/example/git/trees/final?recursive=0&opaque_redirect=redirect-secret",
    ]);
    expect(result).toMatchObject({
      requested_uri: "https://api.github.com/repos/acme/example/git/trees/start?recursive=1",
      final_uri: "https://api.github.com/repos/acme/example/git/trees/final?recursive=0",
      redirects: [{
        from_uri: "https://api.github.com/repos/acme/example/git/trees/start?recursive=1",
        to_uri: "https://api.github.com/repos/acme/example/git/trees/final?recursive=0",
        status_code: 302,
      }],
    });
    expect(JSON.stringify(result)).not.toContain("request-secret");
    expect(JSON.stringify(result)).not.toContain("redirect-secret");
  });

  test("unknown query parameter values never appear in HTTP errors", async () => {
    let calls = 0;
    const failure = await client(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/final?opaque_redirect=redirect-error-secret" },
        });
      }
      return new Response("maintenance", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }).fetch("https://example.com/file?opaque_error=error-secret").catch((error) => error);

    expect(failure).toMatchObject({
      code: "http_status_503",
      requested_uri: "https://example.com/file",
      final_uri: "https://cdn.example.com/final",
      redirects: [{
        from_uri: "https://example.com/file",
        to_uri: "https://cdn.example.com/final",
        status_code: 302,
      }],
    });
    expect(JSON.stringify(failure)).not.toContain("error-secret");
    expect(JSON.stringify(failure)).not.toContain("redirect-error-secret");
  });

  test("drops repeated allowlisted parameters from journal-safe URIs", async () => {
    const calls: string[] = [];
    const result = await client(async (input) => {
      calls.push(String(input));
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }).fetch("https://api.github.com/repos/acme/example/git/trees/main?recursive=1&recursive=0");

    expect(calls).toEqual([
      "https://api.github.com/repos/acme/example/git/trees/main?recursive=1&recursive=0",
    ]);
    expect(result.requested_uri).toBe("https://api.github.com/repos/acme/example/git/trees/main");
    expect(result.final_uri).toBe("https://api.github.com/repos/acme/example/git/trees/main");
  });

  test("does not apply the recursive allowlist outside the GitHub tree endpoint", async () => {
    const result = await client(async () => new Response("ok", {
      headers: { "content-type": "text/plain" },
    })).fetch("https://example.com/file?recursive=1");

    expect(result.requested_uri).toBe("https://example.com/file");
    expect(result.final_uri).toBe("https://example.com/file");
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

  test("observes a resolver rejection when the deadline expires before racing it", async () => {
    const sentinel = new Error("late resolver rejection");
    let leaked = false;
    const onUnhandled = (reason: unknown) => {
      if (reason === sentinel) leaked = true;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const bounded = client(
        async () => new Response("unused"),
        { timeout_ms: 5 },
        async () => {
          const blockedUntil = performance.now() + 15;
          while (performance.now() < blockedUntil) {
            // Force the deadline to expire before beforeDeadline() receives the rejected Promise.
          }
          throw sentinel;
        },
      );

      await expect(bounded.fetch("https://example.com/file")).rejects.toMatchObject({ code: "timeout" });
      await Bun.sleep(10);
      expect(leaked).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
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

  test("cancels a timed-out body reader exactly once", async () => {
    let cancelCalls = 0;
    const bodyStall = client(async () => ({
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      body: {
        getReader: () => ({
          read: async () => await new Promise<never>(() => {}),
          cancel: async () => {
            cancelCalls += 1;
            await new Promise<void>(() => {});
          },
        }),
      },
    }) as unknown as Response, { timeout_ms: 5 });

    await expect(bodyStall.fetch("https://example.com/file")).rejects.toMatchObject({ code: "timeout" });
    expect(cancelCalls).toBe(1);
  });

  test("terminates every response rejected before body consumption even when cancellation blocks", async () => {
    const cases: Array<{
      name: string;
      response: (body: ReadableStream<Uint8Array> | null) => Response;
      expectedCode: string;
      config?: { max_bytes?: number; max_redirects?: number };
      expectsBody?: boolean;
    }> = [
      {
        name: "non-2xx status",
        response: (body) => new Response(body, {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
        expectedCode: "http_status_503",
      },
      {
        name: "refused content type",
        response: (body) => new Response(body, {
          headers: { "content-type": "not-a-media-type" },
        }),
        expectedCode: "missing_or_invalid_content_type",
      },
      {
        name: "excessive Content-Length",
        response: (body) => new Response(body, {
          headers: { "content-type": "text/plain", "content-length": "33" },
        }),
        expectedCode: "response_too_large",
        config: { max_bytes: 32 },
      },
      {
        name: "missing body",
        response: () => ({
          status: 200,
          headers: new Headers({ "content-type": "text/plain" }),
          body: null,
        }) as unknown as Response,
        expectedCode: "missing_response_body",
        expectsBody: false,
      },
      {
        name: "redirect limit exceeded",
        response: (body) => new Response(body, {
          status: 302,
          headers: { location: "https://example.com/next" },
        }),
        expectedCode: "too_many_redirects",
        config: { max_redirects: 0 },
      },
      {
        name: "redirect validation before body consumption",
        response: (body) => new Response(body, {
          status: 302,
          headers: { location: "http://example.com/not-https" },
        }),
        expectedCode: "scheme_not_allowed",
      },
    ];

    for (const testCase of cases) {
      let activeRequests = 0;
      let openStreams = 0;
      let cancelCalls = 0;
      const body = testCase.expectsBody === false
        ? null
        : new ReadableStream<Uint8Array>({
            start() {
              openStreams += 1;
            },
            async cancel() {
              cancelCalls += 1;
              openStreams -= 1;
              await new Promise<void>(() => {});
            },
          });
      const rejected = client(
        async (_input, init) => {
          activeRequests += 1;
          init?.signal?.addEventListener("abort", () => {
            activeRequests -= 1;
          }, { once: true });
          return testCase.response(body);
        },
        { timeout_ms: 20, ...testCase.config },
      );

      const started = performance.now();
      const outcome = await Promise.race([
        rejected.fetch("https://example.com/file")
          .then(() => "resolved")
          .catch((error: HttpAcquisitionError) => error.code),
        Bun.sleep(100).then(() => "still_pending"),
      ]);

      expect({
        name: testCase.name,
        outcome,
        activeRequests,
        openStreams,
        cancelCalls,
      }).toEqual({
        name: testCase.name,
        outcome: testCase.expectedCode,
        activeRequests: 0,
        openStreams: 0,
        cancelCalls: testCase.expectsBody === false ? 0 : 1,
      });
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  test("preserves terminal error codes when response cancellation throws synchronously", async () => {
    let transportAborted = false;
    const rejected = client(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        transportAborted = true;
      });
      return {
        status: 503,
        headers: new Headers({ "content-type": "text/plain" }),
        body: {
          cancel() {
            throw new Error("synchronous cancellation failure");
          },
        },
      } as unknown as Response;
    });

    await expect(rejected.fetch("https://example.com/file")).rejects.toMatchObject({ code: "http_status_503" });
    expect(transportAborted).toBe(true);
  });

  test("closes a real transport socket after a terminal response rejection", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.write("maintenance");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const { port } = server.address() as AddressInfo;
      const rejected = client(async (_input, init) => await fetch(`http://127.0.0.1:${port}/stall`, {
        signal: init?.signal,
      }));

      await expect(rejected.fetch("https://example.com/file")).rejects.toMatchObject({ code: "http_status_503" });
      const closed = await Promise.race([
        new Promise<boolean>((resolve) => {
          const check = () => {
            if (sockets.size === 0) {
              resolve(true);
            } else {
              setTimeout(check, 5);
            }
          };
          check();
        }),
        Bun.sleep(500).then(() => false),
      ]);

      expect({ closed, sockets: sockets.size }).toEqual({
        closed: true,
        sockets: 0,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("preserves streamed byte-limit errors when reader cancellation throws synchronously", async () => {
    let transportAborted = false;
    let reads = 0;
    const rejected = client(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        transportAborted = true;
      });
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/octet-stream" }),
        body: {
          getReader: () => ({
            read: async () => {
              reads += 1;
              return { done: false, value: new Uint8Array([1, 2]) };
            },
            cancel() {
              throw new Error("synchronous reader cancellation failure");
            },
          }),
        },
      } as unknown as Response;
    }, { max_bytes: 1 });

    await expect(rejected.fetch("https://example.com/file")).rejects.toMatchObject({ code: "response_too_large" });
    expect({ reads, transportAborted }).toEqual({ reads: 1, transportAborted: true });
  });

  test("cancels a received body when acquiring its reader fails", async () => {
    let transportAborted = false;
    let cancelCalls = 0;
    const rejected = client(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        transportAborted = true;
      });
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: {
          getReader() {
            throw new Error("reader acquisition failure");
          },
          cancel: async () => {
            cancelCalls += 1;
          },
        },
      } as unknown as Response;
    });

    await expect(rejected.fetch("https://example.com/file")).rejects.toMatchObject({ code: "network_error" });
    expect({ cancelCalls, transportAborted }).toEqual({ cancelCalls: 1, transportAborted: true });
  });

  test("aborts terminal network failures", async () => {
    let fetchAborted = false;
    const fetchFailure = client(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        fetchAborted = true;
      });
      throw new Error("transport failure");
    });
    await expect(fetchFailure.fetch("https://example.com/file")).rejects.toMatchObject({ code: "network_error" });
    expect(fetchAborted).toBe(true);

    let readAborted = false;
    let readerCancelCalls = 0;
    const readFailure = client(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        readAborted = true;
      });
      return {
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        body: {
          getReader: () => ({
            read: async () => {
              throw new Error("body read failure");
            },
            cancel: async () => {
              readerCancelCalls += 1;
            },
          }),
        },
      } as unknown as Response;
    });
    await expect(readFailure.fetch("https://example.com/file")).rejects.toMatchObject({ code: "network_error" });
    expect({ readAborted, readerCancelCalls }).toEqual({ readAborted: true, readerCancelCalls: 1 });

    let redirectAborted = false;
    let redirectCancelCalls = 0;
    const redirectCancelFailure = client(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        redirectAborted = true;
      });
      return {
        status: 302,
        headers: new Headers({ location: "https://example.com/next" }),
        body: {
          cancel: async () => {
            redirectCancelCalls += 1;
            throw new Error("redirect cancellation failure");
          },
        },
      } as unknown as Response;
    });
    await expect(redirectCancelFailure.fetch("https://example.com/file")).rejects.toMatchObject({
      code: "network_error",
    });
    expect({ redirectAborted, redirectCancelCalls }).toEqual({ redirectAborted: true, redirectCancelCalls: 1 });
  });

  test("classifies a transport rejection after the deadline as timeout", async () => {
    let transportAborted = false;
    const lateRejection = client(
      async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          transportAborted = true;
        });
        setTimeout(() => {
          const blockedUntil = Date.now() + 15;
          while (Date.now() < blockedUntil) {
            // Hold the event loop past the deadline before rejecting.
          }
          reject(new Error("late transport failure"));
        }, 1);
      }),
      { timeout_ms: 5 },
    );

    await expect(lateRejection.fetch("https://example.com/file")).rejects.toMatchObject({ code: "timeout" });
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
