---
title: "Untitled Conversation 70"
type: note
created: 2022-12-10
updated: 2022-12-10
source: chatgpt-export
conversation_id: 090a2fa9-bbec-4277-b6fd-8ab6bbae4e06
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 70

> Conversation ID: 090a2fa9-bbec-4277-b6fd-8ab6bbae4e06
> Created: 2022-12-10T20:43:54Z
> Updated: 2022-12-10T20:43:54Z
> Messages: 2

---

## User

how can i send a POST request from a chrome extension

---

## Assistant

To send a POST request from a Chrome extension, you can use the `XMLHttpRequest` or `fetch` API. Here's an example using `fetch`:

```
fetch('https://www.example.com/submit', {
  method: 'POST',
  body: JSON.stringify({
    name: 'John Doe',
    email: 'johndoe@gmail.com'
  }),
  headers: {
    'Content-Type': 'application/json'
  }
});
```

This example sends a POST request to `https://www.example.com/submit` with a JSON-encoded body containing the name and email of the user. The `Content-Type` header is set to `application/json` to indicate that the body of the request is JSON-encoded.




## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
