---
title: "Untitled Conversation 6038"
type: note
created: 2022-12-13
updated: 2022-12-13
source: chatgpt-export
conversation_id: 86de0354-c87e-4d0c-a0e8-2772bc2b400e
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 6038

> Conversation ID: 86de0354-c87e-4d0c-a0e8-2772bc2b400e
> Created: 2022-12-13T19:16:02Z
> Updated: 2022-12-13T19:16:02Z
> Messages: 2

---

## User

chrome.contextMenus.create({
  id: "openJovie",
  title: "Open Jovie",
  contexts: ["link"],
});

rewrite the above function so that it first checks to see if the element already exists and only creates it if it does not.

---

## Assistant

Here is one possible way to rewrite the function to check if the element already exists before creating it:

```
function createContextMenu() {
  chrome.contextMenus.remove("openJovie"); // remove the element if it already exists
  chrome.contextMenus.create({
    id: "openJovie",
    title: "Open Jovie",
    contexts: ["link"],
  });
}
```

Alternatively, you can use the `chrome.contextMenus.get()` method to check if the element exists before creating it, like this:

```
function createContextMenu() {
  chrome.contextMenus.get("openJovie", (menu) => {
    if (!menu) { // check if the element exists
      chrome.contextMenus.create({
        id: "openJovie",
        title: "Open Jovie",
        contexts: ["link"],
      });
    }
  });
}
```

Note that the `chrome.contextMenus` API is only available to extensions and not to regular web pages. You can only use these functions if you are creating an extension for Google Chrome.
