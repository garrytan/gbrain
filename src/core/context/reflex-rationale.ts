export interface ReflexPointerRationaleInput {
  arm: string;
  display: string;
}

/** Canonical rationale template shared by every delivered reflex channel. */
export function reflexPointerRationale(pointer: ReflexPointerRationaleInput): string {
  return `${pointer.arm} match "${pointer.display}"`;
}
