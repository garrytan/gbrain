---
title: "Untitled Conversation 309"
type: note
created: 2022-12-10
updated: 2022-12-10
source: chatgpt-export
conversation_id: 24532398-baf3-4b14-992b-16109908a4be
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 309

> Conversation ID: 24532398-baf3-4b14-992b-16109908a4be
> Created: 2022-12-10T19:37:03Z
> Updated: 2022-12-10T19:37:03Z
> Messages: 2

---

## User

Error in invocation of notifications.create(optional string notificationId, notifications.NotificationOptions options, optional function callback): Error at parameter 'options': Unexpected property: 'options'.

---

## Assistant

It looks like you're trying to use the `notifications.create` method in Google Cloud, but you're providing an unexpected property in the `options` parameter. The `options` parameter should contain properties that define the details of the notification, such as the title, body, and icon. 

Here is an example of how you might use the `notifications.create` method:

```
const {Notification} = require('@google-cloud/notifications');

const client = new Notification();

const options = {
  title: 'Notification title',
  body: 'This is the body of the notification',
  icon: 'http://example.com/my-icon.png'
};

client.create(options, (err, result) => {
  if (err) {
    // Handle the error
    return;
  }

  // Notification created successfully
  console.log(result);
});
```

Make sure you're providing the correct properties in the `options` parameter and that you're not including any additional, unexpected properties.
