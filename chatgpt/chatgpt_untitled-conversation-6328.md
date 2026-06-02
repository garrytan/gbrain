---
title: "Untitled Conversation 6328"
type: guide
created: 2022-12-10
updated: 2022-12-10
source: chatgpt-export
conversation_id: aa002ed8-f7f7-4e12-a23c-72d15c321751
message_count: 4
tags: [chatgpt, import, code]
---
# Untitled Conversation 6328

> Conversation ID: aa002ed8-f7f7-4e12-a23c-72d15c321751
> Created: 2022-12-10T08:17:25Z
> Updated: 2022-12-10T08:17:25Z
> Messages: 4

---

## User

export function handleContextMenuClick(info, tab) {
  if (info.menuItemId === "openJovie") {
    chrome.tabs.create({ url: "https://jov.ie" });
  } else if (info.menuItemId === "saveLinkToJovie") {
    const socialMediaRegex = /^https?:\/\/(instagram\.com|twitter\.com|tiktok\.com|twitch\.tv)/;

    if (socialMediaRegex.test(info.linkUrl)) {
        //
      //send a post request to the backend to save the link
      fetch("https://jov.ie/api/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: info.linkUrl,
        }),
      })
        .then((response) => response.json(console.log("Request sent to backend")))
        .then((data) => {
          console.log("Success:", data);
        })
        .catch((error) => {
          console.error("Error:", error);
        });
    }
  }
}

if the url of the link is a social media profile for tiktok, twitch, twitter, or instagram, i want to extract the username from the profile and set it as a variable either instagram =, twitch=, twitter=, or tiktok=, and then pass it in the request

---

## Assistant

Here's one way you could go about it:

```
const socialMediaRegex = /^https?:\/\/(instagram\.com|twitter\.com|tiktok\.com|twitch\.tv)/;

if (socialMediaRegex.test(info.linkUrl)) {
  // extract the username from the link URL
  let username = "";
  if (info.linkUrl.includes("instagram.com")) {
    // for Instagram URLs, the username is usually in the last part of the URL after the last '/' character
    username = info.linkUrl.split("/").pop();
  } else if (info.linkUrl.includes("twitter.com")) {
    // for Twitter URLs, the username is usually in the last part of the URL after the last '/' character
    username = info.linkUrl.split("/").pop();
  } else if (info.linkUrl.includes("tiktok.com")) {
    // for TikTok URLs, the username is usually in the second-to-last part of the URL after the second-to-last '/' character
    const parts = info.linkUrl.split("/");
    username = parts[parts.length - 2];
  } else if (info.linkUrl.includes("twitch.tv")) {
    // for Twitch URLs, the username is usually in the last part of the URL after the last '/' character
    username = info.linkUrl.split("/").pop();
  }

  //send a post request to the backend to save the link
  fetch("https://jov.ie/api/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: username,
      url: info.linkUrl,
    }),
  })
    .then((response) => response.json(console.log("Request sent to backend")))
    .then((data) => {
      console.log("Success:", data);
    })
    .catch((error) => {
      console.error("Error:", error);
    });
}
```

This code uses regular expressions to check if the `info.linkUrl` is a social media profile URL, and then it extracts the username from the URL using string manipulation methods like `split()` and `pop()`. It then sends a `POST` request to the backend with the username and link URL as the request body.

Note that this code is just one possible solution and it may not work for all cases, as different social media platforms may have different URL formats for user profiles. You may need to adjust the code to handle these different cases.

---

## User

tiktok ursernames are formatted with an @ symbol before the username. we should make sure we remove that

---

## Assistant

Yes, you're right. TikTok usernames are typically prefixed with an `@` symbol. Here's an updated version of the code that removes the `@` symbol from the username if it is present:

```
const socialMediaRegex = /^https?:\/\/(instagram\.com|twitter\.com|tiktok\.com|twitch\.tv)/;

if (socialMediaRegex.test(info.linkUrl)) {
  // extract the username from the link URL
  let username = "";
  if (info.linkUrl.includes("instagram.com")) {
    // for Instagram URLs, the username is usually in the last part of the URL after the last '/' character
    username = info.linkUrl.split("/").pop();
  } else if (info.linkUrl.includes("twitter.com")) {
    // for Twitter URLs, the username is usually in the last part of the URL after the last '/' character
    username = info.linkUrl.split("/").pop();
  } else if (info.linkUrl.includes("tiktok.com")) {
    // for TikTok URLs, the username is usually in the second-to-last part of the URL after the second-to-last '/' character
    const parts = info.linkUrl.split("/");
    username = parts[parts.length - 2];
    // remove the @ symbol from the username if it is present
    if (username.startsWith("@")) {
      username = username.substring(1);
    }
  } else if (info.linkUrl.includes("twitch.tv")) {
    // for Twitch URLs, the username is usually in the last part of the URL after the last '/' character
    username = info.linkUrl.split("/").pop();
  }

  //send a post request to the backend to save the link
  fetch("https://jov.ie/api/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: username,
      url: info.linkUrl,
    }),
  })
    .then((response) => response.json(console.log("Request sent to backend")))
    .then((data) => {
      console.log("Success:", data);
    })
    .catch((error) => {
      console.error("Error:", error);
    });
}
```

In the code above, we added a check to see if the username extracted from the URL starts with an `@` symbol, and if it does, we remove the `@` symbol using the `substring()` method. This ensures that the username we send in the request to the backend does not include the `@` symbol.




## See Also
- [[chatgpt/chatgpt_untitled-conversation-1180]]
- [[chatgpt/chatgpt_untitled-conversation-120]]
- [[chatgpt/chatgpt_untitled-conversation-128]]
- [[chatgpt/chatgpt_untitled-conversation-157]]
- [[chatgpt/chatgpt_untitled-conversation-261]]
