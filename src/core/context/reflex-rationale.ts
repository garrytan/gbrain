export interface ReflexPointerRationaleInput {
  arm: string;
  display: string;
}

/** Canonical rationale shared by ambient and harness reflex delivery logging. */
export function reflexPointerRationale(pointer: ReflexPointerRationaleInput): string {
  return `${pointer.arm} match "${pointer.display}"`;
}
