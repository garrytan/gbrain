---
title: "Untitled Conversation 399"
type: note
created: 2022-12-09
updated: 2022-12-09
source: chatgpt-export
conversation_id: 2fcdfc0e-379e-4315-bf1d-253b81c3f074
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 399

> Conversation ID: 2fcdfc0e-379e-4315-bf1d-253b81c3f074
> Created: 2022-12-09T21:39:49Z
> Updated: 2022-12-09T21:39:49Z
> Messages: 2

---

## User

In my chrome extension content script i want to set a variable for baseURL.  If the extension was loaded in development mode, id like to set the variable to https://dev.jov.ie otherwise id like to set it https://jov.ie

---

## Assistant

If you want to set a variable based on whether the extension is loaded in development mode or not, you can use the `chrome.runtime.getManifest()` method to check the `update_url` property of the manifest. If the `update_url` property is set, it indicates that the extension is loaded in development mode. Here's an example:

```
// Get the extension manifest
const manifest = chrome.runtime.getManifest();

// Check the update_url property of the manifest
if (manifest.update_url) {
  // Extension is loaded in development mode
  // Set the baseURL variable to the development URL
  var baseURL = "https://dev.jov.ie";
} else {
  // Extension is not loaded in development mode
  // Set the baseURL variable to the production URL
  var baseURL = "https://jov.ie";
}
```

Note that this code should be run in the content script. Also, keep in mind that the `chrome.runtime` API is only available in content scripts and background scripts, and cannot be used in the extension's popup or options pages.




## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
