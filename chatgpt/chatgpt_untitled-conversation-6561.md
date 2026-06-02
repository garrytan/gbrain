---
title: "Untitled Conversation 6561"
type: note
created: 2022-12-13
updated: 2022-12-13
source: chatgpt-export
conversation_id: c39da3e7-751f-482f-af7e-ba63c4211712
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 6561

> Conversation ID: c39da3e7-751f-482f-af7e-ba63c4211712
> Created: 2022-12-13T23:24:47Z
> Updated: 2022-12-13T23:24:47Z
> Messages: 2

---

## User

chrome.contextMenus.create({
  id: "saveLinkToJovie",
  title: "Save To Jovie",
  contexts: ["link"],
  targetUrlPatterns: ["*://*.instagram.com/*", "*://*.twitter.com/*", "*://*.tiktok.com/*", "*://*.twitch.tv/*"],
});

chrome.contextMenus.create({
  id: "openJovie",
  title: "Open Jovie in a new tab",
  contexts: ["all"],
});
chrome.contextMenus.create({
  contexts: ["link"],
  parentId: "saveLinkToJovie",
  id: "saveToList",
  title: "Save To List",
});
chrome.contextMenus.create({
  type: "separator",
  contexts: ["link"],
  parentId: "saveLinkToJovie",
  id: "separator1",
});

How can i add an item that is just a title and doesnt not do anything

---

## Assistant

To add an item that is just a title and does not do anything, you can use the `chrome.contextMenus.create` method to create a new context menu item and specify a `title` and `type` for the item. The `type` can be set to `"separator"` to create a horizontal line in the context menu that separates items, or it can be set to `"normal"` to create a regular context menu item. Here is an example of how you can create a context menu item that is just a title and does not do anything:

```
chrome.contextMenus.create({
  id: "titleItem",
  title: "Title",
  type: "normal",
  contexts: ["all"],
});
```

This will create a new context menu item with the title "Title" that does not do anything when clicked. You can specify the `contexts` in which the item should appear, or use the `"all"` value to make the item appear in all contexts.




## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
