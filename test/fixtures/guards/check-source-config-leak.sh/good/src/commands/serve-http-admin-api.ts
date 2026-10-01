// Guard self-test fixture (known-GOOD): the serializer redacts first.
declare const source: { id: string; config: Record<string, unknown> };
declare const res: { json: (v: unknown) => void };
declare function redactSourceConfig(c: Record<string, unknown>): Record<string, unknown>;
export function safe(): void {
  const redacted = redactSourceConfig(source.config);
  res.json(source.config === redacted ? redacted : redactSourceConfig(source.config));
}
