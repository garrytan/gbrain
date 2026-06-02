---
title: "Untitled Conversation 6728"
type: note
created: 2022-12-09
updated: 2022-12-09
source: chatgpt-export
conversation_id: d68dde8e-6660-40a7-a9d1-35a3245c0ff4
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 6728

> Conversation ID: d68dde8e-6660-40a7-a9d1-35a3245c0ff4
> Created: 2022-12-09T21:45:30Z
> Updated: 2022-12-09T21:45:30Z
> Messages: 2

---

## User

when a user right clicks on a link, id like to pass the url of that link to a function in my chrome extension. how can i do this

---

## Assistant

To pass the URL of a link to a function in your Chrome extension, you can use the `chrome.tabs.query` method to get the URL of the current active tab, and then pass it to your function as an argument. Here's an example of how you might do this:

```
function handleRightClick(info, tab) {
  // Get the URL of the active tab
  chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
    var activeTab = tabs[0];
    var activeTabUrl = activeTab.url;

    // Pass the URL to your function
    yourFunction(activeTabUrl);
  });
}

// Set up a right-click listener
chrome.contextMenus.create({
  title: "Do something with this link",
  contexts: ["link"],
  onclick: handleRightClick
});
```

In this example, the `handleRightClick` function is called whenever the user right-clicks on a link. It uses the `chrome.tabs.query` method to get the URL of the active tab, and then passes it to the `yourFunction` function as an argument.

Note that this example assumes that your extension has been granted the `"tabs"` permission in its manifest file. You can learn more about using the `chrome.tabs` API and requesting permissions in the [Chrome Extension documentation](https://developer.chrome.com/extensions).


## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
