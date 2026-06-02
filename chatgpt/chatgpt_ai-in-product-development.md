---
title: "AI in Product Development"
type: note
created: 2026-01-15
updated: 2026-01-15
source: chatgpt-export
conversation_id: 69693fc0-e224-8330-b94b-dc8968b0f3ee
message_count: 2
tags: [chatgpt, import, long-form]
---
# AI in Product Development

> Conversation ID: 69693fc0-e224-8330-b94b-dc8968b0f3ee
> Created: 2026-01-15T19:28:08Z
> Updated: 2026-01-15T19:29:39Z
> Messages: 2

---

## User

So, just like thinking here and like, about AI and using AI and software and stuff, and competing with AI and stuff. And, you know, I think about a lot of products that I would have built in the past, and if I were to build now, like the difference between AI, right? And so like, one product that I previously worked on in the past was like a social CRM, and the idea was that we extracted social URLs and let you take a social URL anywhere on the internet, and we turned that into a contact in your CRM. So for example, you could go on to, you know, the Andreessen Horowitz website and see a list of all their partners, and all their partners have their picture and their name and a little Twitter link and a LinkedIn link, right? Well, we had a Chrome extension that would let you right-click on that Twitter link or that LinkedIn link, and go, and then there was a little menu built into the Chrome context menu that said, our, you know, CRM, and listed all of your lists from the CRM, and it let you add that to a list of like, oh, here's investors or something, right? Add it to a list. Here's the, you know, consumer investors or B2B investors, something like that, right? Now, what that entailed in the Chrome extension was like building, you know, building identifiers to find that profile and stuff and match that profile, right? Now what you could theoretically do now is... Rather than, you know, and then we would go on that Twitter profile, adjust it, and then go, we would save that Twitter profile into this thing, and then we would have an agent in the background go out and, or a crawler, go out and scrape it with like Puppeteer or Playwright or like a JavaScript, you know, like a browserless or something, right? And we'd scrape it. And then we'd get that data. Now, what that entailed was you programming every single social network in there manually, so that we could support it, right? So like, with AI, I see a situation where you might just, you know, instead of doing that, we might just do an API call to OpenAI and say something like, you know, hey, we've got this, you know, extract the name and the profile photo from the link. And then it would probably do a good job of getting that for you, right? And then you wouldn't have to program every single web page. At the same time, a more deterministic approach would be to simply say, well, we've got AI, we can have AI go out and scrape that page, figure out the elements that we want, and then put those element ID numbers into the scraper, and then have a deterministic scraper that's going to work accurately every single time for that network, and just spend one day programming in 50, 60, 70 social networks, and now we have support for every social network, and it's deterministic and it's good, and we can hash out the bugs and clean it up, right? And AI can improve it over time, right? So I guess my point here is that since we have that, kind of, like, it doesn't necessarily make sense in my mind to use AI to do that. It's really regular programming that could have been done 20 years ago, right? And yeah, AI just makes it so that we can code it faster, right? So what I'm getting at is, like, I see AI useful in terms of coding, in terms of rolling out features and support for things more quickly. But in terms of, like, actually using AI, the only thing that really would be relevant in that scenario is, you know, maybe, like, image recognition is a little bit better with AI than OCR, so like maybe, you know, someone's screenshot the profile, and then we can just upload that screenshot to AI, and that might be better, you know, that's probably a good use case for it. We wouldn't necessarily then, you know, program a scraper to understand, or like an OCR agent to understand every single screenshot. We would just throw it through AI. That makes sense to me. But, you know, like, and then, like, other situations like, I'm trying to think of, like, you know, for example, um, uh. You know, for example, we do in a fitness app, and you know, having a fitness app basically look at your, you know, automatically import all your scale readings for the last, you know, year or something, and then make suggestions based on that of like, oh, you should probably start cutting soon because you've gained a lot of fat, or oh, you should start massing or go into maintenance. Well, yeah, we could have just feed that through an AI and then ask it to, but we could also just like spend one day having an AI program in an algorithm that's based on like, okay, well, we know you should never cut more than, you know, eight weeks at a time without a maintenance break or 12 weeks max. You know, bulking under eight weeks is probably inefficient. You know, you probably don't wanna go over 15% body fat because you'll lose visibility. So if you're over 15% body fat, just tell them to cut. You never wanna go below 6% body fat as a male because it's not healthy, you know? And then just write that out as code, right? And not even bother feeding that into AI. And so like the agent doesn't even have to be necessarily intelligent. It could just be that we use the AI to help us program an algorithm. And so with that, like logic in mind, Dude, I'm fucking parking, you piece of shit. I don't... I'm just kind of like... What would be the point of using, not what's the point of using AI, but like, is AI truly enabling anything that, like at the end of the day, it seems to me in most of these situations, it's better to deterministically program the thing with AI helping you to just do that faster than it is to actually use AI for every single call. Even things like, I saw Lalo sent out an email today saying they have a new AI email tool that basically you write an email and then it automatically like bolds a certain line or it, you know, turns up a ticket, an Eventbrite button, or an Eventbrite link into a buy tickets button or something. Well, yeah, but we could also just deterministically program anytime we see a ticketing platform link to turn that into a button and then have a list of ticketing provider platforms and have OpenAI or Claude go out and scrape or tell us what all the ticketing platforms are we should support. And then in a couple hours, I can have a deterministic way to turn any ticketing platform into a button. You know what I mean? So I'm just like, I'm trying to understand as we're building software and thinking about how to use AI to turn AI into things, you know, and then the other thing I see all the time is like the chatbot interface where it's just like, interact with the chatbot interface. But like, that doesn't necessarily make the product better because if your whole product is based off a chatbot interface, first of all, then just make a connector into ChatGPT because people are already using ChatGPT. Why would they go to your chatbot to chat about something? Like it doesn't really make sense to me. Kind of like, it seems to me like the moat of things is like custom interfaces around the experience, and then at that point, you don't really have a chatbot. So, anyway, as I'm thinking about this, I'm just trying to understand, like, what are companies doing to use AI in their products that is actually, like, something you, that would, is better done with AI than just deterministic programming. And like, off the top of my head, the only thing I can really think of is like, maybe running AI through, you know, you upload a song, and it analyzes the song, and like, like, stem separation with AI, and then generate, generate.

---

## Assistant

Mr. White — you’re basically describing the right default: **if the problem is well-specified, bounded, and testable, deterministic code wins** (and AI’s role is “write the code faster,” not “be in the loop at runtime”).

Where AI is *actually* better as a runtime component is when at least one of these is true:

### When AI belongs in the product loop (not just the dev loop)

1) **Unstructured → structured**
- Natural language, messy HTML, PDFs, screenshots, emails, chat logs, call transcripts, forms with weird formatting.
- The value is that AI can handle *variance* without you enumerating it.
- Key tell: you can’t write a clean spec that covers the long tail.

2) **The long tail is the product**
- If supporting “the next 10,000 weird edge cases” is core value, AI beats a growing zoo of parsers.
- Deterministic approaches scale linearly with surfaces; AI scales with *novelty* (imperfectly, but faster).

3) **Fuzzy judgments / high-dimensional heuristics**
- “Is this a good intro?” “Does this email sound too aggressive?” “What’s the likely intent of this message?”
- You can write rules, but they’ll be brittle, and users will constantly want exceptions.

4) **Language generation is the deliverable**
- Not “turn link into button,” but “write the persuasive follow-up given context,” “summarize this thread,” “draft a tailored investor update,” “rewrite in my voice.”
- Deterministic code can’t compete because the output space is creative and contextual.

5) **Semantic retrieval + synthesis**
- Search across lots of docs/threads and answer questions with citations, or generate a brief that stitches sources together.
- Classic keyword search + templates doesn’t cut it once queries become “conceptual.”

6) **Personalization at scale**
- When rules become “per-user models” (preferences, tone, goals, constraints) and the product adapts continuously.
- Deterministic can do it, but you quickly end up building a mini-ML/decisioning platform anyway.

7) **Human-in-the-loop automation**
- AI proposes; user approves/edits; system learns preferences.
- This is where AI can be “good enough” safely because the workflow contains it.

---

### Applying this to your examples

**Social CRM**
- If your promise is “works reliably on the top 50 domains,” then yes: deterministic scraper + tests is king.
- If your promise is “works anywhere,” then AI becomes useful **as a long-tail fallback**, not the primary path:
  - deterministic extraction first (fast, cheap, correct)
  - AI fallback when selector rules fail
  - ask for confirmation when confidence is low
  - cache results + store learned selectors
- The *best* AI use here is often: **LLM generates/repairs selectors + regression tests**, and your runtime stays deterministic.

**Fitness app recommendations**
- “Never cut more than X” etc. is absolutely rules-engine territory.
- Where AI adds real product value:
  - turning noisy logs into structured signals (free-text meals, “I slept like shit,” inconsistent weigh-ins)
  - explaining decisions in natural language *in the user’s tone*
  - generating plans **constrained** by your deterministic guardrails (AI writes the plan; rules validate/clip it)

**Email tool (bolding lines, turning links into buttons)**
- The transformations you described should be deterministic.
- AI’s real wedge is:
  - selecting *what* to emphasize (what line should be bold) based on context + goal
  - rewriting copy for clarity/urgency without sounding like a robot
  - summarizing long threads and generating the “next best reply”
- So: deterministic rendering + AI for *content selection/generation*.

---

### Why “just add a chatbot UI” is usually weak
You’re right: “we have a chatbot” isn’t a moat. The moat is either:
- **workflow integration** (where the user already works),
- **proprietary context/data** (history, outcomes, preferences),
- **trust + eval harness** (it’s consistently correct in a narrow domain),
- **latency/cost advantage** via hybrid systems,
- **distribution** (you’re in the inbox/IDE/CRM, not another tab).

The strongest AI products feel like **software that happens to use AI**, not “a chat window.”

---

### A practical rule for deciding “AI runtime vs deterministic”
Use AI at runtime when the product needs **adaptation to variability** more than it needs **perfect repeatability**.

And if you need both, the winning architecture is usually:
- **Deterministic core**
- **AI for interpretation/generation**
- **Guardrails + verification + caching**
- **Human approval for high-impact actions**

---

If you want, I can turn this into a quick decision checklist you can apply to any feature (“AI-in-loop”, “AI-at-dev-time only”, or “hybrid fallback”) and map it to costs/latency/reliability tradeoffs.
