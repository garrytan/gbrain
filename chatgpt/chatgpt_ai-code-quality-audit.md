---
title: "AI Code Quality Audit"
type: note
created: 2026-01-31
updated: 2026-01-31
source: chatgpt-export
conversation_id: 697e8b1b-d05c-8329-abe8-ac461dafa643
message_count: 1
tags: [chatgpt, import]
---
# AI Code Quality Audit

> Conversation ID: 697e8b1b-d05c-8329-abe8-ac461dafa643
> Created: 2026-01-31T23:07:40Z
> Updated: 2026-01-31T23:07:52Z
> Messages: 1

---

## User

Yeah, so I'm about to give you a list of issues that we've had in the past where we had done programming work and for whatever reason went in the wrong direction. For example, you know, we had one situation where we had, you know, we have all these AI agents working on our code base and we've had, we had a situation where we had, we were using Drizzle ORM. and the neon serverless driver, and, you know, we had other, we had, and we're using the neon provided pooling endpoint. We had a situation where we had all these users like manually going in and doing all of the pooling, handling pooling themselves. So we have like PG pooler and all the manual pooling and stuff. And then had three different cavities drivers being used to write to Postgres out of this use, giving somewhere some places using the pooled connection, some not, and then transaction use all over the place, even though we have an HTTP driver, which means that there shouldn't be any transaction use. And so what I'm trying to do now is basically do a little audit of all those problems that we've had in the past and then add in guardrails to the agent's md file, add agent skills in cloud code, and also add slash commands if needed. And when I say add, it could be add or modify existing ones, and add any biome or ESLint rules, preferably biome, but ESLint if needed, rules. That will act or like pre-commit hooks or post-edit hooks or anything like that in Claude or Linsurfers or anything. All these things to basically extract these patterns and then prevent them from happening in the future so that our AI agents are writing better code from the get-go that better fits our stack and performs better and doesn't and breaks less so that I can spend more of my time on actually running the company and building out new features and stuff and less on patching up the sloppy AI work.
