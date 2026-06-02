---
title: "Chat Input Specs"
type: note
created: 2026-05-15
updated: 2026-05-15
source: chatgpt-export
conversation_id: 6a06b21f-2424-83e8-87fc-e144a6debbec
message_count: 3
tags: [chatgpt, import, code]
---
# Chat Input Specs

> Conversation ID: 6a06b21f-2424-83e8-87fc-e144a6debbec
> Created: 2026-05-15T05:41:52Z
> Updated: 2026-05-15T05:43:56Z
> Messages: 3

---

## User

grab the specs size wise of the chat inptu component here

---

## Assistant

Mr. White, I can identify the active chat input structure, though exact computed pixel bounds aren’t exposed here. I’ll provide practical size specs and a snippet to measure exact values.

---

## Assistant

Mr. White, the ChatGPT input composer here is roughly this size/spec pattern:

```css
.chatInputShell {
  width: min(calc(100vw - 32px), 768px);
  min-height: 88px;
  max-height: min(40vh, 280px);
  margin-inline: auto;
  padding: 10px 12px;
  border-radius: 28px;
}

.chatInputTextArea {
  width: 100%;
  min-height: 24px;
  max-height: 180px;
  font-size: 16px;
  line-height: 24px;
  padding: 8px 4px;
  resize: none;
  overflow-y: auto;
}

.chatInputToolbar {
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.chatInputIconButton {
  width: 36px;
  height: 36px;
  border-radius: 999px;
  flex: 0 0 auto;
}

.chatInputPillButton {
  height: 36px;
  padding-inline: 12px;
  border-radius: 999px;
}
```

Usable design specs:

| Part | Size |
|---|---:|
| Outer composer max width | `768px` |
| Mobile width | `calc(100vw - 32px)` |
| Collapsed height | `~88–96px` |
| Border radius | `28px` |
| Outer padding | `10–12px` |
| Text input min height | `24px` |
| Text input line height | `24px` |
| Text font size | `16px` |
| Toolbar height | `40px` |
| Icon buttons | `36x36px` |
| Pill buttons | `36px` height |
| Gap between controls | `8px` |
| Max expanded height | `~280px` or `40vh` |

Exact browser-measurement snippet:

```js
(() => {
  const input =
    document.querySelector('[contenteditable][aria-label="Chat with ChatGPT"]') ||
    document.querySelector('textarea[aria-label="Chat with ChatGPT"]');

  let node = input;
  const rows = [];

  for (let i = 0; node && i < 8; i++, node = node.parentElement) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);

    rows.push({
      level: i,
      tag: node.tagName,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      padding: style.padding,
      margin: style.margin,
      borderRadius: style.borderRadius,
      display: style.display,
      gap: style.gap,
      maxWidth: style.maxWidth,
      minHeight: style.minHeight,
    });
  }

  console.table(rows);
})();
```

For Jovie, I’d copy the pattern as:

```css
.jovieChatInput {
  width: min(calc(100vw - 32px), 720px);
  min-height: 88px;
  max-height: min(42vh, 280px);
  padding: 10px 12px;
  border-radius: 28px;
  display: grid;
  gap: 8px;
}

.jovieChatInput textarea,
.jovieChatInput [contenteditable="true"] {
  min-height: 24px;
  max-height: 168px;
  font-size: 16px;
  line-height: 24px;
  overflow-y: auto;
}

.jovieChatInput__toolbar {
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.jovieChatInput__button {
  height: 36px;
  min-width: 36px;
  border-radius: 999px;
}
```

The key size constraints are `max-width: 720–768px`, `min-height: ~88px`, `36px` action buttons, `16px / 24px` text, and `28px` radius.


## See Also
- [[chatgpt/chatgpt_automate-webpage-data-input]]
- [[chatgpt/chatgpt_bind-input-value-to-content-script]]
- [[chatgpt/chatgpt_extract-input-element-to-component]]
- [[chatgpt/chatgpt_fix-invalid-input]]
- [[chatgpt/chatgpt_format-currency-input-text]]
