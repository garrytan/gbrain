---
title: "Untitled Conversation 6042"
type: note
created: 2022-12-10
updated: 2022-12-10
source: chatgpt-export
conversation_id: 87ab4ed1-385e-4fd2-9641-105891881cbf
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 6042

> Conversation ID: 87ab4ed1-385e-4fd2-9641-105891881cbf
> Created: 2022-12-10T19:45:20Z
> Updated: 2022-12-10T19:45:20Z
> Messages: 2

---

## User

chrome.notifications.create("notification", {
  type: "basic",
  title: "Contact saved to Jovie",
  iconUrl: "src/assets/icons/tick-mark.png",
  message: "We've saved this contact to Jovie.",
});

add a link to https://jov.ie

---

## Assistant

To add a link to https://jov.ie in the notification, you can include the URL as part of the message text. For example:

```
chrome.notifications.create("notification", {
  type: "basic",
  title: "Contact saved to Jovie",
  iconUrl: "src/assets/icons/tick-mark.png",
  message: "We've saved this contact to Jovie. Visit https://jov.ie for more information.",
});
```

Alternatively, you can add a clickable link to the notification by using the `contextMessage` property and providing a `buttons` array that includes the link. For example:

```
chrome.notifications.create("notification", {
  type: "basic",
  title: "Contact saved to Jovie",
  iconUrl: "src/assets/icons/tick-mark.png",
  message: "We've saved this contact to Jovie.",
  contextMessage: "Visit Jovie",
  buttons: [
    {
      title: "Visit Jovie",
      iconUrl: "https://jov.ie/favicon.ico",
      // When the user clicks the button, open the Jovie website
      onClick: () => window.open("https://jov.ie", "_blank"),
    },
  ],
});
```

Note that the `buttons` property and the `onClick` event are not supported by all versions of Chrome, so you may need to check for browser compatibility before using this approach.


## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
