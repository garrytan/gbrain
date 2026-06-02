---
title: "Vue Emit and Listener"
type: note
created: 2022-12-23
updated: 2022-12-23
source: chatgpt-export
conversation_id: 962818ec-6f7f-4100-88be-fb763af5bf5a
message_count: 2
tags: [chatgpt, import, code]
---
# Vue Emit and Listener

> Conversation ID: 962818ec-6f7f-4100-88be-fb763af5bf5a
> Created: 2022-12-23T22:27:53Z
> Updated: 2022-12-23T22:27:53Z
> Messages: 2

---

## User

@click="
                toggleArchiveCreators(
                  creator.id,
                  !creator.crm_record_by_user.archived
                )
              "

make this an emit and add a listener to the parent

---

## Assistant

To make this a Vue.js component emit and add a listener to the parent component, you can do the following:

1. In the child component, add an `emit` to the `@click` event handler:

```
@click="toggleArchiveCreators(creator.id, !creator.crm_record_by_user.archived); $emit('archive-creators', creator.id, !creator.crm_record_by_user.archived)"
```

2. In the parent component, add a listener for the `archive-creators` event in the `template`:

```
<template>
  <child-component @archive-creators="handleArchiveCreators"></child-component>
</template>
```

3. In the parent component's `script` section, add a method to handle the `archive-creators` event:

```
methods: {
  handleArchiveCreators(creatorId, archived) {
    // Do something with the creatorId and archived values
  }
}
```

Now, when the child component's `@click` event is triggered, it will emit an `archive-creators` event, and the parent component will receive the event and execute the `handleArchiveCreators` method with the provided arguments.

