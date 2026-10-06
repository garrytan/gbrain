// mock-ubicloud-api.ts — an in-process stand-in for Ubicloud's POST /cli
// endpoint, enough for scripts/ubicloud/ubi-runner.sh: `vm list`, `vm L/N
// create` (slow on purpose, and completed even when the client hangs up, like
// the real API), `vm L/N show` (404 once gone) and `vm L/N destroy -f`.
// VMs never reach `running`, so every `up` stays mid-provision until killed.

export interface MockVm {
  location: string;
  name: string;
  size: string;
  state: "creating" | "destroying";
}

export interface MockUbicloudOptions {
  /** Delay before a create lands, per VM name. Default 0. */
  createDelayMs?: (name: string) => number;
  /** Delay between `destroy` and the VM disappearing. Default 200. */
  destroyDelayMs?: number;
  /** Refuse every create with Ubicloud's vCPU quota error (400). */
  rejectCreates?: boolean;
  seed?: Array<{ location?: string; name: string; size?: string }>;
}

export interface MockUbicloud {
  url: string;
  vms: Map<string, MockVm>;
  /** "create-start N", "created N", "create-rejected N", "destroy N", "removed N", in order. */
  events: string[];
  stop(): void;
}

export function startMockUbicloud(opts: MockUbicloudOptions = {}): MockUbicloud {
  const vms = new Map<string, MockVm>();
  const events: string[] = [];
  for (const vm of opts.seed ?? []) {
    vms.set(vm.name, { location: vm.location ?? "eu-central-h1", name: vm.name, size: vm.size ?? "standard-16", state: "creating" });
  }
  const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { argv } = (await req.json()) as { argv: string[] };
      if (argv[0] !== "vm") return text(`! unsupported: ${argv.join(" ")}`, 400);
      if (argv[1] === "list") {
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
        vms.set(name, { location, name, size, state: "creating" });
        events.push(`created ${name}`);
        return text(`VM created with id: vm-${name}`);
      }
      const vm = vms.get(name);
      if (verb === "show") {
        if (!vm) return text("! Unexpected response status: 404", 404);
        return text(`id: vm-${name}\nname: ${name}\nstate: ${vm.state}\nlocation: ${vm.location}\nsize: ${vm.size}\n`);
      }
      if (verb === "destroy") {
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
  return { url: `http://127.0.0.1:${server.port}`, vms, events, stop: () => server.stop(true) };
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
