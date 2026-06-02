---
title: "Trigger Function with HTML Button"
type: note
created: 2023-01-31
updated: 2023-01-31
source: chatgpt-export
conversation_id: 60ed6535-9485-4a15-ab1a-cee29c287942
message_count: 2
tags: [chatgpt, import, code]
---
# Trigger Function with HTML Button

> Conversation ID: 60ed6535-9485-4a15-ab1a-cee29c287942
> Created: 2023-01-31T04:46:50Z
> Updated: 2023-01-31T04:46:50Z
> Messages: 2

---

## User

in a chrome extension how do i trigger a function from the content script with a button on an html page

---

## Assistant

You can use the `chrome.runtime.sendMessage` method to send a message from the content script to the background script and trigger a function. 

1. In the content script, listen for a click event on the button and send a message:
```
document.querySelector("button").addEventListener("click", function() {
  chrome.runtime.sendMessage({ action: "buttonClicked" });
});
```

2. In the background script, listen for messages and trigger the function:
```
chrome.runtime.onMessage.addListener(function(request) {
  if (request.action === "buttonClicked") {
    functionToBeTriggered();
  }
});
```
