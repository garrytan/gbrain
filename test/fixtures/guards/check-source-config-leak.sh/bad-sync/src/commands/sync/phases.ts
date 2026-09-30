// Guard self-test fixture (known-BAD): a sync phase module (refactor wave 1) serializes a sources row's raw
// config (webhook_secret leak class) with no redactor call nearby.
declare const source: { id: string; config: Record<string, unknown> };
declare const res: { json: (v: unknown) => void };
export function leak(): void {
  console.log(JSON.stringify(source.config));
}
