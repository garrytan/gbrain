---
title: "New Chat"
type: note
created: 2022-12-19
updated: 2022-12-19
source: chatgpt-export
conversation_id: 6665cabe-f02f-4250-a800-df8410244034
message_count: 2
tags: [chatgpt, import, code]
---
# New Chat

> Conversation ID: 6665cabe-f02f-4250-a800-df8410244034
> Created: 2022-12-19T23:41:04Z
> Updated: 2022-12-19T23:41:04Z
> Messages: 2

---

## User

:shortcut="
                          $store.state.platform === 'mac'
                            ? ['⌘', '⇧', 'Q']
                            : ['Ctrl', '⇧', 'Q']
                        "

change this to opeion and alt symbols

---

## Assistant

To use the option symbol (⌥) and the alt symbol (Alt) in this shortcut, you can update the string as follows:

```
:shortcut="
    $store.state.platform === 'mac'
        ? ['⌘', '⌥', 'Q']
        : ['Ctrl', 'Alt', 'Q']
"
```

This will use the `⌥` symbol for the option key on macOS and the `Alt` symbol for the alt key on other platforms.

Note that the `⇧` symbol represents the shift key, and the `⌘` symbol represents the command key on macOS. The `Ctrl` symbol represents the control key on other platforms.

I hope this helps! Let me know if you have any other questions.
