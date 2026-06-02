---
title: "Make function async"
type: note
created: 2022-12-24
updated: 2022-12-24
source: chatgpt-export
conversation_id: 7030b0de-d35a-41b0-9c0c-27cdfba4b193
message_count: 2
tags: [chatgpt, import, code]
---
# Make function async

> Conversation ID: 7030b0de-d35a-41b0-9c0c-27cdfba4b193
> Created: 2022-12-24T03:06:56Z
> Updated: 2022-12-24T03:06:56Z
> Messages: 2

---

## User

getUserLists() {
      UserService.getUserLists().then((response) => {
        response = response.data;
        if (response.status) {
          this.userLists = [];
          this.userLists = response.lists;
        }
      });
    },

make this async

---

## Assistant

To make this function async, you will need to update the function declaration to include the `async` keyword and use the `await` keyword when calling the `getUserLists` method:

```
async getUserLists() {
  try {
    const response = await UserService.getUserLists();
    if (response.status) {
      this.userLists = [];
      this.userLists = response.lists;
    }
  } catch (error) {
    // handle error
  }
}
```

Note that you should also wrap the call to `getUserLists` in a try-catch block to handle any errors that may occur.

It's also a good idea to consider adding some sort of loading or loading error state to your component so that the user is aware of what is happening while the lists are being fetched.

