---
conversation_id: 69dac68a-4a94-83e8-a843-198ad31e8cb6
created: 2026-04-11
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Claude Cloud Session Issues
type: note
updated: 2026-04-11
---

# Claude Cloud Session Issues

> Conversation ID: 69dac68a-4a94-83e8-a843-198ad31e8cb6
> Created: 2026-04-11T22:10:09Z
> Updated: 2026-04-11T22:11:57Z
> Messages: 4

---

## User

It seems as of late that whenever I use Claude code in the Claude app, either on desktop or on mobile, and I use a cloud environment, like the hosted one, instead of using a local environment, that it stalls out. And it seems to stall out when it's not, when I'm not using it, right? Like, I'll assign it to do something, and then I won't, I'll stop using it, and it'll stop doing that thing, and then I'll, like, open up the Claude app again on my Mac, and I don't mean I'm, like, closing the app, I'm just putting it in the background, and then I'll, like, reopen it, and then as soon as I start typing in the inbox, in the input, even if I don't send it, all of a sudden you see it start to activate again, and it starts to continue the task. I know that Claude has had crazy issues with keeping up with demand, and I've generally noticed. And other issues and I’m just wondering if this is like one of those things where do you think that they have like deliberately and I’ve noticed that they’ve done things like they’re giving they’re doing like the old TeleComp thing of like free nights and weekends where they’re like, doubling your usage and off hours for like limited promotions and stuff which my assumption was that they were doing that to encourage people to code in off hours to kind of balance out the demand and I’m wondering if you know they’ve state you know as they’ve started rolling out more automation and we’ve started like you know using doing longer running sessions and stuff and more people are using it that the demand is just scaling at crazy rates that they can’t keep up with. Do we think that it’s possible that when I’m the behavior I’m seeing was an active design choice to increase increase Supply and basically say hey if you’re using a cloud thing verse that you know these apps or something we’re basically gonna not let it run in the background perpetually. We’re gonna force you. We’re gonna pause it when you’re not actively using the application to kind of like encourage people to use not use the cloud and use like a local environment or something or or discard them from doing long running tasks in the cloud cause like it’s working if that was the goal was like I used to do so much in the app like I’d go to the gym and I just start firing off tasks that I’d be firing off like 1010 to 15 parallel agents at the gym just all running in sequence and then like having them auto open PR and then close them and like at any given point for my two hours I’d probably fire off in 50 to 100 tasks with 10 to 1580s at any given moment in you know my hour and a half at the gym and now I just left the gym. I fired off three and they didn’t even finish and so now what I’m doing is I’m spending a lot more time on my local environment, running agents in parallel on my local system and running multiple computers at home and doing a lot less on at least on Claude cloud now I have my own CI and stuff and Crowne jobs on desktops and shit, which is a separate thing but like it has changed my behavior because it’s become unreliable so like do we think that they’re potentially like deliberately making it pause when you’re an active to to deal with Supply

---

## Assistant

I’m checking for two things: whether Anthropic documents any background-execution limits for Claude Code in hosted environments, and whether there’s evidence of recent capacity controls or demand-management behavior.

---

## Assistant

There is one useful data point already: Anthropic’s current docs explicitly say cloud sessions are supposed to persist even if you close your laptop. That makes your observed “only resumes when I foreground the app” behavior look more like a bug, app lifecycle issue, or resource-throttling side effect than the intended product contract.

---

## Assistant

Mr. White,

Public evidence points against “they intentionally pause hosted Claude Code work whenever you background the app” as the primary design. Anthropic’s own docs say cloud sessions “persist even if you close your laptop,” can be monitored from mobile, and are meant for “long-running tasks” that you “check back” on later. Their docs also say cloud scheduled tasks run on Anthropic-managed infrastructure and “keep running even when your computer is off.” That is the stated product behavior. citeturn263902view0turn263902view1

Anthropic is clearly managing capacity aggressively. They currently document peak-hour limits, priority access during high-traffic periods for Pro, discretionary caps on usage “to manage capacity,” and they ran a March 13–28, 2026 promotion that doubled usage outside 8 AM–2 PM ET on weekdays across Claude, Cowork, and Claude Code. That supports your broader theory that demand pressure is real and they are actively shaping usage patterns. citeturn263902view4turn502804view0

The stronger read is this: your symptom looks more like a reliability bug, session-heartbeat issue, or foreground-triggered client refresh than an openly intended “inactive user pause” policy. The fact pattern you described — progress resuming when the app regains focus or even when you start typing — is consistent with a client-side wakeup or subscription refresh problem. Recent status history also shows repeated Claude issues in late March and early April 2026, including desktop app errors on April 1, desktop/web connection errors on April 8, elevated errors across products on April 10, and a March 29 incident where Dispatch sessions in Claude Desktop were “not responding.” citeturn263902view2

My confidence split would be roughly:
1. Reliability / client-session bug: high.
2. Backend throttling under load: medium.
3. Deliberate hidden “pause when user inactive” behavior: low.

Three quick ways to verify which it is:
- Run the same cloud task, background Desktop, and watch the same session from mobile or web. If progress continues there, the bug is in the Desktop client path.
- Compare actual git/PR timestamps against the moments you foreground the app. If commits cluster only after focus returns, backend execution may truly be stalling.
- Try the web surface for the same hosted workflow. Anthropic explicitly positions web cloud sessions for unattended long-running work, so a web-vs-desktop difference is a strong signal. citeturn263902view0turn263902view1

My bottom line: capacity constraints are real, and Anthropic openly uses promotions and limits to manage them. The specific behavior you’re seeing is more likely an implementation problem than the intended contract of their cloud environment.


**Topic:** [[chatgpt-clusters/coding_ai]]
