---
title: "Floating UI fix"
type: note
created: 2025-09-02
updated: 2025-09-02
source: chatgpt-export
conversation_id: 68b77fbe-2954-8328-bb21-39e0a176bb9d
message_count: 2
tags: [chatgpt, import, code]
---
# Floating UI fix

**Related:** [[coding_troubleshoot]]

> Conversation ID: 68b77fbe-2954-8328-bb21-39e0a176bb9d
> Created: 2025-09-02T23:37:47Z
> Updated: 2025-09-02T23:38:18Z
> Messages: 2

---

## User

Floating ui jumps the element from the corner on load to its proper location

---

## Assistant

Got you, Mr. White. That “corner → snap-in” is the floating element rendering before Floating UI computes its position (FOUC/layout shift).

Fix it fast:

1) Compute before paint
- Use `whileElementsMounted: autoUpdate` (it runs an initial sync) and mount with `useLayoutEffect` timing under the hood.
- Don’t position in a plain `useEffect`.

2) Don’t show until positioned
- Start hidden until you have real `x/y`. Either `opacity:0; pointer-events:none` or render-gate on `isPositioned`.

3) Use fixed strategy (often smoother)
- `strategy: 'fixed'` avoids scroll-container offsets that can cause an initial jump.

4) Avoid 0,0 flash
- Apply a temporary off-screen transform until `x/y` exist.

5) Animate via transform only
- Keep `top/left` for layout; animate with `transform` to avoid reflow.

Minimal React example:

```tsx
import {useState} from 'react';
import {useFloating, offset, flip, shift, autoUpdate} from '@floating-ui/react';

export function Menu() {
  const [open, setOpen] = useState(false);

  const {refs, floatingStyles, x, y, strategy, update} = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    middleware: [offset(8), flip(), shift({padding: 8})],
    whileElementsMounted: autoUpdate, // initial sync before paint + live updates
    strategy: 'fixed',
  });

  const isPositioned = x != null && y != null;

  return (
    <>
      <button ref={refs.setReference} onClick={() => setOpen(v => !v)}>
        Toggle
      </button>

      {open && (
        <div
          ref={refs.setFloating}
          style={{
            ...floatingStyles,                       // sets position + top/left
            transform: isPositioned ? 'translate3d(0,0,0)' : 'translate3d(-9999px, -9999px, 0)',
            opacity: isPositioned ? 1 : 0,           // no corner flash
            pointerEvents: isPositioned ? 'auto' : 'none',
            willChange: 'transform',
          }}
          onAnimationEnd={() => update()}             // if you animate in
        >
          …menu…
        </div>
      )}
    </>
  );
}
```

Quick checklist:
- ✅ `whileElementsMounted: autoUpdate`
- ✅ `strategy: 'fixed'`
- ✅ Hide until `x/y` ready
- ✅ No CSS transitions on `top/left`; animate `transform`/`opacity`
- ✅ If SSR: render floating only client-side or gate until hydrated to avoid mismatch

If it still jumps, it’s usually:
- Reference not sized yet (wrap `open` toggle after reference mounts).
- Parent CSS transitions affecting layout—remove transitions on ancestors during mount.
- A portal re-parenting late—ensure the portal container exists before opening.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_fix-floating-stats-layout]]
- [[chatgpt/chatgpt_floating-dust-effect-setup]]
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
- [[chatgpt/chatgpt_1-of-body-weight-part2]]
