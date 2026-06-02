---
title: "Shared Chat Memory Clarification"
type: note
created: 2026-03-10
updated: 2026-03-10
source: chatgpt-export
conversation_id: 69b082ab-c82c-8326-8256-d61b9ac26000
message_count: 2
tags: [chatgpt, import]
---
# Shared Chat Memory Clarification

> Conversation ID: 69b082ab-c82c-8326-8256-d61b9ac26000
> Created: 2026-03-10T20:44:49Z
> Updated: 2026-03-10T20:45:38Z
> Messages: 2

---

## User

Yo, if I share a chat with ChatGPT with another person, does that chat pull memory for both users and context for both users in the chat? So like, if I have a ChatGPT account and Liv has a ChatGPT account and we have a shared conversation, is it gonna, like, use all of Liv's previous conversations and my previous conversations to inform its answers?

---

## Assistant

Mr. White, no. ChatGPT does **not** merge your private history and Liv’s private history into one shared memory pool. citeturn661129view0turn661129view1

If you mean a **Group Chat** inside ChatGPT, OpenAI says group chats are separate from individual conversations. In a group chat, ChatGPT can access only the messages, files, and images in that group, plus participants’ names/profile photos and any group-specific instructions. It does **not** see your 1:1 chats, your personal memory, or your account-level custom instructions. The same applies to Liv. citeturn661129view0

If you mean a **shared link**, that is just a snapshot of a conversation. OpenAI says anyone with the link can view it, and if they reply, it creates a **copy in their own chat history**. Shared links do not continue as one live shared thread anymore. citeturn661129view2

So the practical answer is:

- **Your old chats do not get pulled into Liv’s answers.**
- **Liv’s old chats do not get pulled into your answers.**
- In a **group chat**, the shared context is the **group thread itself**. citeturn661129view0
- In a **shared-link copy**, the conversation lives under the account of whoever imported/replied to it. OpenAI’s memory docs say chat history and saved memory are used from that user’s own account when enabled, so Liv’s copy would be influenced by **Liv’s** memory settings, and yours by **yours**. That last sentence is an inference from the official docs. citeturn661129view1turn276192view2

The cleanest mental model is: **shared conversation content can be shared; account memory stays private to each account**.


## See Also
- [[chatgpt/chatgpt_film-vs-memory-debate]]
- [[chatgpt/chatgpt_honcho-memory-for-jovie]]
- [[chatgpt/chatgpt_jovie-artist-memory-calendar]]
- [[chatgpt/chatgpt_memory-activation-request]]
- [[chatgpt/chatgpt_memory-and-agent-workflow]]
