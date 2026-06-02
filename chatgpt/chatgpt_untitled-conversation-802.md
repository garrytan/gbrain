---
title: "Untitled Conversation 802"
type: note
created: 2022-12-12
updated: 2022-12-12
source: chatgpt-export
conversation_id: 5ca928b8-1be4-4d0c-9ea7-8f280b56b8b7
message_count: 3
tags: [chatgpt, import]
---
# Untitled Conversation 802

> Conversation ID: 5ca928b8-1be4-4d0c-9ea7-8f280b56b8b7
> Created: 2022-12-12T21:00:46Z
> Updated: 2022-12-12T21:00:46Z
> Messages: 3

---

## User

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
  }
  

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

only execut the request if the network is suppported

---

## Assistant

This code looks like it is intended to save a link to a social media profile to Jovie. The function takes in a `token` and a `link` as arguments. The `token` is likely an authentication token that will be used to authenticate the request to the Jovie API.

The function begins by extracting the social network and username from the `link` using the `getSocialHandleFromLink` function. It then checks if the network is supported by Jovie by checking if it exists in the `supportedNetworks` array. If the network is not supported, the function shows a notification to the user and returns.

Next, the function sends a POST request to the Jovie API using the `ky` library, along with the `username` extracted from the `link`. The function then handles the response from the API, logging any errors and showing notifications to the user accordingly.

Overall, this code looks functional, but it is missing some important details, such as what `getSocialHandleFromLink` does and how the `notificationId` variable is being used. It also uses the deprecated `chrome.notifications` API, which has been replaced by the `Notification` API in modern versions of Chrome.

---

## Assistant

It looks like this function is used to save a URL to Jovie, a social media management tool. The function takes a `token` and a `link` as input. It then uses a `ky` library to make an API request to Jovie, passing the `token` in the request headers for authentication. The `link` is passed to the `getSocialHandleFromLink` function to extract the username and network as separate values. The function then checks if the network is in the `supportedNetworks` array. If it is not, it shows a notification to the user saying that the link is not supported by Jovie. If the network is supported, it makes a `POST` request to the Jovie API and saves the link. If the request is successful, it shows a notification to the user. If there is an error, it shows a notification to the user.
