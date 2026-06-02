---
title: "Untitled Conversation 6312"
type: note
created: 2022-12-12
updated: 2022-12-12
source: chatgpt-export
conversation_id: a8443d6c-033e-4441-aceb-3ce214b5f3c9
message_count: 1
tags: [chatgpt, import]
---
# Untitled Conversation 6312

> Conversation ID: a8443d6c-033e-4441-aceb-3ce214b5f3c9
> Created: 2022-12-12T21:05:37Z
> Updated: 2022-12-12T21:05:37Z
> Messages: 1

---

## User

refactor this code

export async function saveURLToJovie(token, link) {
  //get the social handle from the link
  //run the link through the getSocialHandleFromLink function to get the username and network as a seperate values

  const api = ky.extend({
    hooks: {
      beforeRequest: [
        (request) => {
          request.headers.set("Authorization", `Bearer ${token}`);
        },
      ],
    },
  });
  //log the link
  console.log("Save to Jovie link", link);
  const { network, username } = getSocialHandleFromLink(link);

  //log the username and network
  console.log("username", username);
  //set supportedNetwork to instagram, tiktok, twitter, twitch
  const supportedNetworks = ["instagram", "tiktok", "twitter", "twitch"];
  //if the network is not in the supportedNetworks array show the user a chrome notification that the link is not supported
  if (!supportedNetworks.includes(network)) {
    //show a notification "Link not supported"
    chrome.notifications.create("jovie-notification-" + notificationId++, {
      type: "basic",
      title: "Link not supported",
      iconUrl: "src/assets/icons/cross-mark.png",
      message: "This link is not supported by Jovie.",
      requireInteraction: false,
    });
    return;
  } else {
    const json = await api
      .post("https://dev.jov.ie/api/import", { json: { instagram: username } })

      .json()
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
          A; //show a notification "Please login to Jovie to save links"
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
}
