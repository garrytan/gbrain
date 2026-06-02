---
title: "Untitled Conversation 6374"
type: note
created: 2022-12-09
updated: 2022-12-09
source: chatgpt-export
conversation_id: af1d53b2-f2fe-4e51-b95c-084c242aadde
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 6374

> Conversation ID: af1d53b2-f2fe-4e51-b95c-084c242aadde
> Created: 2022-12-09T22:20:48Z
> Updated: 2022-12-09T22:20:48Z
> Messages: 2

---

## User

Id like to create a context menu in chrome with 2 child elements. the aprent should be called Save to Jovie and the child should be called Save and Open

---

## Assistant

To create a context menu in Chrome with two child elements, you can use the `chrome.contextMenus` API. Here's an example of how you might do this:

```javascript
// First, create the parent context menu
chrome.contextMenus.create({
  id: "save_to_jovie",
  title: "Save to Jovie",
  contexts: ["all"],
});

// Then, create the two child context menu items
chrome.contextMenus.create({
  id: "save",
  title: "Save",
  parentId: "save_to_jovie",
  contexts: ["all"],
});

chrome.contextMenus.create({
  id: "open",
  title: "Open",
  parentId: "save_to_jovie",
  contexts: ["all"],
});
```

This code creates a parent context menu called "Save to Jovie" with two child items: "Save" and "Open". When a user right-clicks on any page, they will see the "Save to Jovie" menu, and when they hover over it, they will see the two child items.

To handle clicks on the context menu items, you can use the `chrome.contextMenus.onClicked` event listener, which will fire whenever a context menu item is clicked. Here's an example of how you might use this event listener to handle clicks on the "Save" and "Open" items:

```javascript
chrome.contextMenus.onClicked.addListener(function(info, tab) {
  if (info.menuItemId === "save") {
    // Handle the "Save" menu item here
  } else if (info.menuItemId === "open") {
    // Handle the "Open" menu item here
  }
});
```

In this code, the `onClicked` event listener checks the `menuItemId` property of the `info` object to determine which menu item was clicked. Based on the `menuItemId`, it either handles the "Save" menu item or the "Open" menu item.

I hope this helps! Let me know if you have any other questions.


## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
