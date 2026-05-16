import { describe, it, expect } from 'bun:test';
import { classifyWorkerExit } from '../src/core/minions/exit-classification.ts';

describe('classifyWorkerExit', () => {
  it('code=0 → clean_exit', () => {
    expect(classifyWorkerExit({ code: 0 })).toBe('clean_exit');
  });

  it('code=1 (runtime error) → crash', () => {
    expect(classifyWorkerExit({ code: 1 })).toBe('crash');
  });

  it('code=137 (SIGKILL) → crash', () => {
    expect(classifyWorkerExit({ code: 137 })).toBe('crash');
  });

  it('code=null (signal-only exit, audit JSON shape) → crash', () => {
    expect(classifyWorkerExit({ code: null })).toBe('crash');
  });

  it('missing code (older audit shape with undefined key) → crash', () => {
    // JSON.stringify drops undefined keys; reader may see {} or {code: null}.
    // Both must classify as crash so a corrupted/legacy row doesn't get
    // silently demoted into the clean-restart bucket.
    expect(classifyWorkerExit({})).toBe('crash');
  });
});
