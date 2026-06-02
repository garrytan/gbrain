---
title: "Untitled Conversation 1180"
type: note
created: 2022-12-10
updated: 2022-12-10
source: chatgpt-export
conversation_id: 67cf9ff5-2954-42c6-9a27-e56bbf62b9d9
message_count: 6
tags: [chatgpt, import, code]
---
# Untitled Conversation 1180

> Conversation ID: 67cf9ff5-2954-42c6-9a27-e56bbf62b9d9
> Created: 2022-12-10T00:44:31Z
> Updated: 2022-12-10T00:44:31Z
> Messages: 6

---

## User

 chrome.tabs.create({
      url: "https://jov.ie?link=" + info.linkUrl,
    });

How can i make this code work when the link is twitter or instagram but otherwise not work

---

## Assistant

It is not clear what you are asking, but you can use an `if` statement to check if the link is from Twitter or Instagram and only create a new tab in those cases. Here is an example:

```
if (info.linkUrl.startsWith("https://twitter.com") || info.linkUrl.startsWith("https://instagram.com")) {
  chrome.tabs.create({
    url: "https://jov.ie?link=" + info.linkUrl,
  });
}
```

This code checks if the link starts with `https://twitter.com` or `https://instagram.com` and creates a new tab only in those cases. Otherwise, it does nothing.

---

## User

what about if i want to check 4 or 5 network urls

---

## Assistant

You can add more `or` statements to your `if` statement to check for multiple URLs. Here is an example that checks for four different URLs:

```
if (info.linkUrl.startsWith("https://twitter.com") ||
    info.linkUrl.startsWith("https://instagram.com") ||
    info.linkUrl.startsWith("https://facebook.com") ||
    info.linkUrl.startsWith("https://linkedin.com")) {
  chrome.tabs.create({
    url: "https://jov.ie?link=" + info.linkUrl,
  });
}
```

This code checks if the link starts with `https://twitter.com`, `https://instagram.com`, `https://facebook.com`, or `https://linkedin.com` and creates a new tab only in those cases. Otherwise, it does nothing.

---

## User

can you rewrite it to check only for instagram, twitter, tiktok, and twitch

---

## Assistant

```
if (info.linkUrl.startsWith("https://instagram.com") ||
    info.linkUrl.startsWith("https://twitter.com") ||
    info.linkUrl.startsWith("https://tiktok.com") ||
    info.linkUrl.startsWith("https://twitch.com")) {
  chrome.tabs.create({
    url: "https://jov.ie?link=" + info.linkUrl,
  });
}
```

This code checks if the link starts with `https://instagram.com`, `https://twitter.com`, `https://tiktok.com`, or `https://twitch.com` and creates a new tab only in those cases. Otherwise, it does nothing.


## See Also
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
- [[chatgpt/chatgpt_untitled-conversation-265]]
