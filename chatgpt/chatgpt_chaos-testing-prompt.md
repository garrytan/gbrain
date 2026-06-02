---
title: "Chaos Testing Prompt"
type: note
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a00fb6a-1ed8-83e8-aca6-458d18798519
message_count: 1
tags: [chatgpt, import]
---
# Chaos Testing Prompt

> Conversation ID: 6a00fb6a-1ed8-83e8-aca6-458d18798519
> Created: 2026-05-10T21:40:58Z
> Updated: 2026-05-10T22:21:14Z
> Messages: 1

---

## User

Okay, this is a request for a prompt. All you're going to do is generate a prompt. You're not to code anything. You're not to take any action. Just write the prompt. What I'm going to ask you to do in this prompt, I want an agent. I'm going to put this prompt into ChatGPT Alice browser. I'm going to point it at Jobee production site. I'm going to have the site already logged in and authenticated. What I want for this to do is to go through and click, like, and crawl the entire application. Crawl it. And so, when I say crawl, I mean, like, by the end of this, every single page has been visited. And I want it to use all the tools at its disposal in the most efficient possible to look at every screen and find every, by every definition of jank, I want you to find it. So, you know, you scroll down the page and things jitter on a page reload. There's a bunch of layout shifting. When you start typing something, the input jumps around on the screen. You open up one drop down and then another drop down, the first drop down doesn't close. You scroll something on mobile and all of a sudden there's horizontal scrolling happening. Everything you can think of, right? You know, anything that would make it feel like it's not a polished product. Is there redundant text on pages? Is there, you know, look through our recent conversations and all the things that we know to look out for and then just fucking go in and find everything. Like, this is a, this is an in-depth QA check. You're looking at everything. Now, important to know, we already have E2E testing. So like, this is going to be like the human version, right? I don't want something that's just going to duplicate what we already have. I want this to be like acting as if you're like a real customer and you're doing things that are like unexpected or whatever. And like, like thinking maybe kind of like chaos testing, but like customer oriented chaos testing. You know what I'm saying? Um And then another thing I would like to do is to think about what the problem is. A problem I generally have is that I never worked with a big tech company, and I didn't know how big tech companies built product. I'm doing my best. I'm taking a lot of guesses. I'm going off the YC advice.
What I would say is I would go through our app and think about big tech companies and their products and SaaS products. Just be like, "What are we missing? What are the obvious things?" Like:
- Oh shit, people don't have a way to delete their account.
- Logging out is actually kind of hard.
- For some reason, there is a gap in billing. This person wouldn't be able to upgrade. This person wouldn't bill it out of grid.
Think about that kind of stuff. Close the gap of things that need to be built that aren't necessarily on my radar because they're not specific to my customer. They're specific to all customers, or things that maybe we built for the customer but we didn't think of. We built a task to generate album art or something, but we didn't think about the fact that, okay, well, now you need a place to view the album art later. We have a library for that, so it's covered in that case, but there are cases where it's not. You know what I mean? Stuff like that.
