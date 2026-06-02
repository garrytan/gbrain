---
title: "FFMI and aesthetics guide"
type: guide
created: 2025-12-08
updated: 2025-12-08
source: chatgpt-export
topic: design-ux
message_count: 8
tags: [chatgpt, knowledge, design-ux]
---
# FFMI and aesthetics guide

> **Source:** ChatGPT conversation
> **Date:** 2025-12-08T21:20:06Z
> **Messages:** 8
> **Topic:** design-ux

## Question

Okay, so for the LogYourBody app, we basically... Um... We basically... Um, for the LogYourBody app, we like... do this thing, um... Okay, so right now we log... your body fat percentage, and your height, and we do progress photos, right? And then we calculate your FFMI. And so basically, because it's based on aesthetics, for guys anyway, we're trying to set... we basically default to, like, a 22.5 FFMI is ideal. If you go... if you're below that, the app guides you to getting up to that. If you're above that, the app suggests that you actually lose muscle mass in order to get down to a 22.5, because we're going for what is most aesthetically pleasing, right? Um... We're also trying to do... Um... Um... And then, we also currently do... Um... body fat percentage, so we guide you down to, like, 8% body fat. If you're, like, below 6%, we say get up. Um... If you're below 4%, we say absolutely fucking put on some weight or you're gonna die. But, um, if you're above 15%, we're like, don't 

## Answer

Mr. White — that’s a very thoughtful and ambitious plan for the app. There are a few problems with treating “arm size → attractiveness / aesthetic ideal” as a clean, data-driven outcome — and as you suspect, the data are limited and inconsistent. Here’s what I see if you try to formalize “ideal arms” (or “arms proportional to height”) — and what seems more realistic for your app to do.  

## ✅ What research / anecdotal tradition suggests

- There is a “classic physique” tradition (e.g. influenced by entity["people","Steve Reeves",0]) which ties ideal measurements to proportions rather than absolute size — for example: arms sized ~ 2.5× wrist circumference. citeturn0search34turn0search33turn0search9  
- More broadly: upper-body proportion (shoulders, waist, chest) seems much more strongly correlated to perceived male attractiveness than absolute arm size or lower-body size. citeturn0search35turn0search22turn0search16  
- Some community / bodybuilding sources note that what “looks good” depends heavily on height/limb length — i.e. short men with say 16″ arms will often appear more “arm-heavy” than tall men with the same arm girth. citeturn0search36turn0search29turn0search1  

So the intuitive idea you started with — that a 20″ arm girth on a 6′4″ man “looks different” than the same arm girth on a 5′6″ man — has merit.

## 🚫 Why there’s no solid science to back “ideal arm girth by height” for aesthetics

- According to a medically reviewed source about biceps size, there’s **no strong or consistent evidence** correlating height with ideal or average biceps circumference. citeturn0search8turn0search27  
- Studies of attractiveness tend to emphasize **torso proportions and waist-to-shoulder (or waist-to-chest) ratios**, rather than limb girths. citeturn0search22turn0search35turn0search13  
- Attempts to turn “ideal measurements” into formulas — e.g. “waist × 1.618 = shoulders” — are based on heuristic or classic-physique traditions, not robust, large-scale, peer-reviewed anthropometric / attractiveness research. citeturn0search37turn0search17turn0search6  
- There is even explicit criticism of the reductionist idea of defining ideal ‘measurements’ for everyone — because bone structure, limb length, muscular insertion points, fat distribution, posture, and other factors vary — making “one ideal arm girth formula” overly simplistic. citeturn0search5turn0search26  

## 🎯 What this means if you build this feature in your app

If you try to **set an “ideal arm size target” based on height**, you risk:

- Over-simplifying what determines what “looks good” (arms are only part of a physique; proportions matter more).  
- Promoting unrealistic or unsustainable goals (especially if someone’s bone structure doesn’t support large arms).  
- Making users compare themselves on a flawed metric — potentially leading to frustration or poor decisions.  

A safer, more defensible approach for your app would be:  

- Use **proportion-b

*(Answer truncated — 4436 chars total)*

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Well, I agree with you on like oversimplification and whatever whatever And like obviously there's going to be noise, and there's going to be variance and stuff like you know I'm saying that 8% body fat is ideal for guys, but like you know obviously there's going to be like some people who You know are are you know get more veiny at 10% body fat or something and 8% won't look as good or something You know because we'll be you know whatever like you know and obviously like when we're dealing with like You know genetic variants and all this stuff like that's all stuff that we're going to take into account But it doesn't mean that we can't shoot for a number, and then you know try and You know make it better as we go so that being said I'm thinking of"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000005b1871f5925750fb856cdcbc', 'content_type': 'audio_asset_pointer', 'expiry_datetime'

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Understood, Mr. White. I get the drift. We can definitely aim for a practical number and refine it as we go. Ultimately, we’ll treat these targets as flexible guides rather than rigid rules. There’s always going to be individual variation, and we can adjust the approach based on how users respond and what the data shows over time.'}
{'asset_pointer': 'sediment://file_00000000067c71f5bde87b787d0d127a', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-06T21:26:16.463951+00:00', 'format': 'wav', 'metadata': {'end': 19.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 914478, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'What I\'m trying to figure out, I guess, is, like, for example, for me personally, I\'m 6\'4". So, you know, and I\'m just trying to figure out, like, you know, at what point are my arms going to, like, look too big? Is there any evidence to suggest that we have, like, you know, have we done any studies where we basically just, like, had a bunch of girls look at a bunch of guys and say whether or not they liked their arms and accounted for variance in height?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000003714722f90064d98633e62fd', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-06T21:27:40.740151+00:00', 'format': 'wav', 'metadata': {'end': 36.47, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 175063

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Mr. White, I\'ll keep it concise: there’s no robust scientific study out there that’s specifically measured how different arm sizes look to a bunch of people while controlling for height. In other words, we don’t really have that kind of direct evidence.\n\nMost of what we know is anecdotal or based on general physique standards from bodybuilding or classic aesthetics, which often focus more on proportions than absolute numbers. So for you at 6\'4", there’s no hard scientific line where arms go from “ideal” to “too big.” It’s more about overall proportions and personal preference.\n\nIn short, we can aim for a proportional guideline rather than a universal rule, and we’ll just refine as we gather feedback.'}
{'asset_pointer': 'sediment://file_00000000d2d071f5a0758a08d57bf3af', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-06T21:27:40.740211+00:00', 'format': 'wav', 'metadata': {'end': 43.25, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2076078, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'So far so good.'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000aee0722faf73be4ec16194b7', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-06T21:29:06.707464+00:00', 'format': 'wav', 'metadata': {'end': 3.06, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 146958, 'tool_audio_direction': None}, 'audio_start_timestamp': 236.0773137579672, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-06-06T21:29:06.707464+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White. We’ll keep it factual and straightforward. There’s no one-size-fits-all data, but we can rely on proportional guidelines and refine them as we go along. Thanks for laying out the details.'}
{'asset_pointer': 'sediment://file_00000000b910722fac1f29f20fbb27ee', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-06-06T21:29:06.707526+00:00', 'format': 'wav', 'metadata': {'end': 12.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 578478, 'tool_audio_direction': None}
