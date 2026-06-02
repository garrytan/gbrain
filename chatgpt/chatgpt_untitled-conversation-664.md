---
title: "Untitled Conversation 664"
type: note
created: 2022-12-12
updated: 2022-12-12
source: chatgpt-export
conversation_id: 4eedcb84-ec5f-4372-a07c-17313c4ac408
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 664

> Conversation ID: 4eedcb84-ec5f-4372-a07c-17313c4ac408
> Created: 2022-12-12T21:13:58Z
> Updated: 2022-12-12T21:13:58Z
> Messages: 2

---

## User

 .post("https://dev.jov.ie/api/import", { json: { `${network}`: username } })

how do i write this properly

---

## Assistant

It looks like you're trying to make a `POST` request to the `https://dev.jov.ie/api/import` URL with a JSON object as the request body. The JSON object has a property whose name is equal to the value of the `network` variable, and the value of that property is equal to the value of the `username` variable.

Here's how you could write this properly:

```
const data = {
  [network]: username
};

fetch("https://dev.jov.ie/api/import", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify(data)
})
  .then(response => response.json())
  .then(json => {
    // do something with the JSON response
  });
```

This code creates a JavaScript object with a property whose name is the value of the `network` variable and whose value is the value of the `username` variable. It then makes a `POST` request to the `https://dev.jov.ie/api/import` URL with that object as the request body. The `Content-Type` header is set to `application/json` to indicate that the request body is in JSON format. Finally, the code uses `.then()` to handle the response from the server.

I hope this helps! Let me know if you have any other questions.


## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
