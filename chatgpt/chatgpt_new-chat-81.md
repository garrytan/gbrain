---
title: "New chat"
type: note
created: 2022-12-23
updated: 2022-12-23
source: chatgpt-export
conversation_id: 56d293ad-4a16-43bb-950a-f3439aa73a60
message_count: 1
tags: [chatgpt, import]
---
# New chat

> Conversation ID: 56d293ad-4a16-43bb-950a-f3439aa73a60
> Created: 2022-12-23T18:12:32Z
> Updated: 2022-12-23T18:12:32Z
> Messages: 1

---

## User

<template>
  <div class="w-full items-center px-4">
    <h1
      v-if="header.includes('all')"
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
      <UserGroupIcon
        class="mr-1 h-4 w-4 rounded-md text-purple-400"
        aria-hidden="true" />
      {{ header + ' Contacts' }}
    </h1>
    <h1
      v-else-if="header.includes('favourites')"
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
      <HeartIcon
        class="mr-1 h-4 w-4 rounded-md text-red-400"
        aria-hidden="true" />
      Favorited
    </h1>
    <h1
      v-else
      class="flex items-center text-sm font-semibold capitalize text-slate-900 dark:text-jovieDark-100">
      <UserIcon
        class="mr-1 h-4 w-4 rounded-md text-sky-400"
        aria-hidden="true" />
      {{ header }}
    </h1>
    <p v-if="header.includes('all')" class="text-2xs font-light text-slate-600">
      {{ subheader.total }} Contacts
    </p>

    <p v-else class="text-2xs font-light text-slate-600">
      {{ subheader[header] }} Contacts
    </p>
  </div>
</template>
<script>
import { UserGroupIcon, HeartIcon, UserIcon } from '@heroicons/vue/24/solid';
export default {
  props: ['header', 'subheader'],
  components: {
    UserGroupIcon,
    HeartIcon,
    UserIcon,
  },
};
</script>

convert this to composition api


## See Also
- [[chatgpt/chatgpt_ai-chat-instrumentation-tools]]
- [[chatgpt/chatgpt_ai-chat-security-test]]
- [[chatgpt/chatgpt_ai-chat-test]]
- [[chatgpt/chatgpt_ai-sdk-chat-development]]
- [[chatgpt/chatgpt_chat-input-specs]]
