// mock-ubicloud-api.ts — an in-process stand-in for Ubicloud's POST /cli
// endpoint, enough for scripts/ubicloud/ubi-runner.sh: `vm list`, `vm L/N
// create` (slow on purpose, and completed even when the client hangs up, like
// the real API), `vm L/N show` (404 once gone) and `vm L/N destroy -f`.
// VMs never reach `running`, so every `up` stays mid-provision until killed,
// unless `running` is set: then a created VM shows as running at 192.0.2.1
// (pair it with a fake `ssh` on PATH). `faults` makes `destroy` or `list`
// answer HTTP 500 / 503 from the next request on; `destroyFaults` answers the
// next destroy requests one by one with a status, or holds one past the
// client's timeout without acting on it ("hang").

export interface MockVm {
  location: string;
  name: string;
  size: string;
  state: "creating" | "running" | "destroying";
}

export interface MockUbicloudOptions {
  /** Delay before a create lands, per VM name. Default 0. */
  createDelayMs?: (name: string) => number;
  /** Delay between `destroy` and the VM disappearing. Default 200. */
  destroyDelayMs?: number;
  /** Refuse every create with Ubicloud's vCPU quota error (400). */
  rejectCreates?: boolean;
  /** Created VMs show as running at 192.0.2.1. */
  running?: boolean;
  /** Answers for the next destroy requests, in order: an HTTP status, or "hang" (3 s, then a 504 nobody reads). */
  destroyFaults?: Array<number | "hang">;
  seed?: Array<{ location?: string; name: string; size?: string }>;
}

export interface MockUbicloud {
  url: string;
  vms: Map<string, MockVm>;
  /** "create-start N", "created N", "create-rejected N", "destroy N", "removed N", in order. */
  events: string[];
  /** Flip to make every later `destroy` (500) or `list` (503) fail. */
  faults: { destroy: boolean; list: boolean };
  /** Every destroy request received, answered or not. */
  destroyRequests: number;
  stop(): void;
}

export function startMockUbicloud(opts: MockUbicloudOptions = {}): MockUbicloud {
  const vms = new Map<string, MockVm>();
  const events: string[] = [];
  const faults = { destroy: false, list: false };
  for (const vm of opts.seed ?? []) {
    vms.set(vm.name, { location: vm.location ?? "eu-central-h1", name: vm.name, size: vm.size ?? "standard-16", state: "creating" });
  }
  const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
  const api = { vms, events, faults, destroyRequests: 0 } as MockUbicloud;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { argv } = (await req.json()) as { argv: string[] };
      if (argv[0] !== "vm") return text(`! unsupported: ${argv.join(" ")}`, 400);
      if (argv[1] === "list") {
        if (faults.list) return text("! Unexpected response status: 503", 503);
        return text([...vms.values()].map((vm) => `${vm.location}  ${vm.name}\n`).join(""));
      }
      const [location, name] = (argv[1] ?? "").split("/") as [string, string];
      const verb = argv[2];
      if (verb === "create") {
        events.push(`create-start ${name}`);
        await Bun.sleep(opts.createDelayMs?.(name) ?? 0);
        if (opts.rejectCreates) {
          events.push(`create-rejected ${name}`);
          return text("! Unexpected response status: 400\nDetails: Validation failed for following fields: size\n  size: Insufficient quota for requested size. Requested vCPU count: 16, currently used vCPU count: 252, maximum allowed vCPU count: 256, remaining vCPU count: 4", 400);
        }
        const size = argv[argv.indexOf("-s") + 1] ?? "standard-16";
        vms.set(name, { location, name, size, state: opts.running ? "running" : "creating" });
        events.push(`created ${name}`);
        return text(`VM created with id: vm-${name}`);
      }
      const vm = vms.get(name);
      if (verb === "show") {
        if (!vm) return text("! Unexpected response status: 404", 404);
        return text(`id: vm-${name}\nname: ${name}\nstate: ${vm.state}\nlocation: ${vm.location}\nsize: ${vm.size}\n${vm.state === "running" ? "ip4: 192.0.2.1\n" : ""}`);
      }
      if (verb === "destroy") {
        api.destroyRequests++;
        const fault = opts.destroyFaults?.shift();
        if (fault === "hang") {
          await Bun.sleep(3000);
          return text("! Unexpected response status: 504", 504);
        }
        if (fault !== undefined) return text(`! Unexpected response status: ${fault}`, fault);
        if (faults.destroy) return text("! Unexpected response status: 500", 500);
        if (vm && vm.state !== "destroying") {
          vm.state = "destroying";
          events.push(`destroy ${name}`);
          setTimeout(() => {
            vms.delete(name);
            events.push(`removed ${name}`);
          }, opts.destroyDelayMs ?? 200);
        }
        return text("Virtual machine, if it exists, is now scheduled for destruction");
      }
      return text(`! unsupported: ${argv.join(" ")}`, 400);
    },
  });
  Object.assign(api, { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) });
  return api;
}

export async function waitForEvent(mock: MockUbicloud, pattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = mock.events.find((e) => pattern.test(e));
    if (hit) return hit;
    await Bun.sleep(25);
  }
  throw new Error(`no event matching ${pattern} within ${timeoutMs}ms; events: ${mock.events.join(", ")}`);
}
