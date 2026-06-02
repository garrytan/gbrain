---
title: "Untitled Conversation 367"
type: note
created: 2022-12-13
updated: 2022-12-13
source: chatgpt-export
conversation_id: 2b0dd34d-7427-4476-9952-35472c5362fa
message_count: 2
tags: [chatgpt, import, code]
---
# Untitled Conversation 367

> Conversation ID: 2b0dd34d-7427-4476-9952-35472c5362fa
> Created: 2022-12-13T04:58:08Z
> Updated: 2022-12-13T04:58:08Z
> Messages: 2

---

## User

 const listResponse = await call
    .get("https://dev.jov.ie/api/user-lists")
    .json

this returns an object:

{"status":true,"lists":[{"id":12,"name":"Saved from the web","emoji":"\ud83d\udcc4","user_id":1,"team_id":1,"created_at":"2022-12-13T01:46:43.000000Z","updated_at":"2022-12-13T01:46:43.000000Z","creators_count":6,"order":0,"pinned":0,"updating_list":false},{"id":11,"name":"Saved from web","emoji":"\ud83c\udf0e","user_id":1,"team_id":1,"created_at":"2022-12-12T22:04:25.000000Z","updated_at":"2022-12-12T22:58:53.000000Z","creators_count":1,"order":1,"pinned":0,"updating_list":false},{"id":5,"name":"New List","emoji":"\ud83d\ude0e","user_id":1,"team_id":1,"created_at":"2022-11-18T18:06:32.000000Z","updated_at":"2022-11-22T18:09:33.000000Z","creators_count":0,"order":2,"pinned":0,"updating_list":false},{"id":1,"name":"Friends In LA","emoji":"\ud83d\udcc4","user_id":1,"team_id":1,"created_at":"2022-10-12T21:37:37.000000Z","updated_at":"2022-11-03T20:53:10.000000Z","creators_count":26,"order":3,"pinned":1,"updating_list":false},{"id":3,"name":"Co-Workers","emoji":"\ud83d\udcbc","user_id":1,"team_id":1,"created_at":"2022-11-03T20:52:21.000000Z","updated_at":"2022-11-03T20:52:43.000000Z","creators_count":1,"order":4,"pinned":1,"updating_list":false},{"id":2,"name":"Creators","emoji":"\ud83c\udfa5","user_id":1,"team_id":1,"created_at":"2022-10-12T21:40:23.000000Z","updated_at":"2022-11-03T20:53:02.000000Z","creators_count":2,"order":5,"pinned":0,"updating_list":false},{"id":4,"name":"W22 Campaign","emoji":"\ud83c\udde7\ud83c\uddee","user_id":1,"team_id":1,"created_at":"2022-11-03T20:53:20.000000Z","updated_at":"2022-11-27T06:12:08.000000Z","creators_count":0,"order":6,"pinned":0,"updating_list":false}]}

I want to get the lists object inside the response and print each lists.name to console

---

## Assistant

To get the `lists` object from the response, you can use the bracket notation to access the property with the key `"lists"`. You can then iterate over the array of lists using a for-loop and print each `name` property to the console. Here's an example:

```
const response = {
  "status": true,
  "lists": [
    {
      "id": 12,
      "name": "Saved from the web",
      "emoji": "\ud83d\udcc4",
      "user_id": 1,
      "team_id": 1,
      "created_at": "2022-12-13T01:46:43.000000Z",
      "updated_at": "2022-12-13T01:46:43.000000Z",
      "creators_count": 6,
      "order": 0,
      "pinned": 0,
      "updating_list": false
    },
    {
      "id": 11,
      "name": "Saved from web",
      "emoji": "\ud83c\udf0e",
      "user_id": 1,
      "team_id": 1,
      "created_at": "2022-12-12T22:04:25.000000Z",
      "updated_at": "2022-12-12T22:58:53.000000Z",
      "creators_count": 1,
      "order": 1,
      "pinned": 0,
      "updating_list": false
    },
    ...
  ]
}

// Get the "lists" array from the response object
const lists = response["lists"];

// Iterate over the array and print each list's "name" property
for (const list of lists) {
  console.log(list.name);
}
```

I hope this helps! Let me know if you have any other questions.
