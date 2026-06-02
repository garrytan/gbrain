---
title: "Untitled Conversation 6631"
type: note
created: 2022-12-11
updated: 2022-12-11
source: chatgpt-export
conversation_id: cb961088-e674-46f9-973f-38e4840292cf
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 6631

> Conversation ID: cb961088-e674-46f9-973f-38e4840292cf
> Created: 2022-12-11T02:21:49Z
> Updated: 2022-12-11T02:21:49Z
> Messages: 2

---

## User

make this use fetch not axios

export function saveURLToJovie() {
  const instance = axios.create({
    adapter: fetchAdapter,
  });
  instance
    .post({
      headers: {
        "Content-Type": "application/json",
        withCredentials: true,
        "x-csrf-token": "eyJpdiI6IklVaXlUQnF4R28vWEc0NkEwUHZ5Unc9PSIsInZhbHVlIjoiQ1puMGR6MW9pcHlBUTJ5UzZ1T2QwaldNakdtdEpYdmU0dWxYdzNEWkxOcUhuMmtPWG9tRHpsdjVXbjN6TzMxaEx1b0x5ZE11TDdRUWIyeE10bE1mYUZvOGgyZ1BqWURlZHBXdVZXa3NkYlpkU0ZGZGI2cU14VVZSdDRYZldDRGIiLCJtYWMiOiI0OGQzOWY3OTA4ODdlMDFjYWVmZjUwM2MxMWVhZWE2NTYwM2YyNDgzZGM4NmUwMDYxZGQ3MmIxZWFhNWNhYmRhIiwidGFnIjoiIn0=",
      },
      body: JSON.stringify({
        instagram: "therock",
      }),
    })
    .then((response) => {
      // handle the response
      if (response.status === 200) {
        console.log("Success:", response.data);
        //show a notification "Link saved to Jovie"
        chrome.notifications.create("jovie-notification-" + notificationId++, {
          type: "basic",
          title: "Link saved to Jovie",
          iconUrl: "src/assets/icons/tick-mark.png",
          message: "Your link has been saved to Jovie.",
          requireInteraction: false,
        });
      } else if (response.status === 401) {
        console.log("Auth error:", response.data);
        //show a notification "Please login to Jovie to save links"
        chrome.notifications.create("jovie-notification-" + notificationId++, {
          type: "basic",
          title: "Please login to Jovie to save links",
          iconUrl: "src/assets/icons/tick-mark.png",
          message: "You must be logged into Jovie to save a link. Login and try again.",
          requireInteraction: false,
        });
      }
    })
    .catch((error) => {
      console.error("Error:", error);
      //notify the user that there was an error
      chrome.notifications.create("jovie-notification-" + notificationId++, {
        type: "basic",
        title: "Error saving link to Jovie",
        iconUrl: "src/assets/icons/tick-mark.png",
        message: "There was an error saving your link to Jovie. Please try again.",
        requireInteraction: false,
      });
    });
}

---

## Assistant

Here's an example of how you could rewrite the code to use `fetch` instead of `axios`:

```
export function saveURLToJovie() {
  fetch("http://some-server.com/save-link", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      withCredentials: true,
      "x-csrf-token": "eyJpdiI6IklVaXlUQnF4R28vWEc0NkEwUHZ5Unc9PSIsInZhbHVlIjoiQ1puMGR6MW9pcHlBUTJ5UzZ1T2QwaldNakdtdEpYdmU0dWxYdzNEWkxOcUhuMmtPWG9tRHpsdjVXbjN6TzMxaEx1b0x5ZE11TDdRUWIyeE10bE1mYUZvOGgyZ1BqWURlZHBXdVZXa3NkYlpkU0ZGZGI2cU14VVZSdDRYZldDRGIiLCJtYWMiOiI0OGQzOWY3OTA4ODdlMDFjYWVmZjUwM2MxMWVhZWE2NTYwM2YyNDgzZGM4NmUwMDYxZGQ3MmIxZWFhNWNhYmRhIiwidGFnIjoiIn0=",
    },
    body: JSON.stringify({
      instagram: "therock",
    }),
  })
  .then(response => {
    if (response.status === 200) {
      console.log("Success:", response.data);
      //show a notification "Link saved to Jovie"
      chrome.notifications.create("jovie-notification-" + notificationId++, {
        type: "basic",
        title: "Link saved to Jovie",
        iconUrl: "src/assets/icons/tick-mark.png",
        message: "Your link has been saved to Jovie.",
        requireInteraction: false,
      });
    } else if (response.status === 401) {
      console.log("Auth error:", response.data);
      //show a notification "Please login to Jovie to save links"
      chrome.notifications.create("jovie-notification-" + notificationId++, {
        type: "basic",
        title: "Please login to Jovie to save links",
        iconUrl: "src/assets/icons/tick-mark.png",
        message: "You must be logged into Jovie to save a link. Login and try again.",
        requireInteraction: false,
      });
    }
  })
  .catch(error => {
    console.error("Error:", error);
    //notify the user that there was an error
    chrome.notifications.create("jovie-notification-" + notificationId++, {
      type: "basic",
      title: "Error saving link to Jovie",
      iconUrl: "src/assets/icons/tick-mark.png",
      message: "There was an error saving your link to Jovie. Please
