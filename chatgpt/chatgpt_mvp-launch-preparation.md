---
conversation_id: 68aa24eb-95c4-8324-8282-17d22950d896
created: 2025-08-23
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 8
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: MVP launch preparation
type: note
updated: 2025-08-23
---

# MVP launch preparation

**Related:** [[business_startup]]

> Conversation ID: 68aa24eb-95c4-8324-8282-17d22950d896
> Created: 2025-08-23T20:34:21Z
> Updated: 2025-08-23T20:36:42Z
> Messages: 8

---

## User

{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000c164622fac132ff3ab7ecf62', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:34:21.188405+00:00', 'format': 'wav', 'metadata': {'end': 193.93, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 9308718, 'tool_audio_direction': None}, 'audio_start_timestamp': 200.66137719599647, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-19T20:34:21.188405+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "I think we just a big thing that really helped that I just did is adding the pre-commit hooks for tests and linting. I'm getting a lot less issues where AI branches or AI agents are pushing code that is causing problems and then we're having to go like debug and stuff. So that I really enjoyed. I haven't made ETE tests required yet as we're just like trying to fix the existing ETE tests and stuff and get to a solid place before I put that requirement in. But once the main flow of onboarding works and passes the ETE test, which is currently being worked on, then I'll require ETE tests before something can merge. And then the next thing that we did that we're still implementing but is nice is having the CI automatically take the AI agent PRs, automatically move them from draft to an actual PR, automatically update branch, and then deal with like merge queue and all that, and automatically set them to auto merge so that it's kind of like seamless that all of these all of these agent codes just go out there and pass some through an AI code review and then pass all the tests and stuff and then automatically get merged back in. So this is a great thing to speed up the development of our MVP. I'm trying to think now of like to get our MVP out there in a situation where anyone can sign up and create a profile and that's like core MVP, not even like with the paid plan yet, just like they can sign up and then we'll make a profile. What are we, and that profile is probably viewable, what are we thinking, like what what else should I be looking out for, what else should I be doing to make sure that like you know this MVP is good to go and that it's solid and that it's gonna work and that there's not gonna be super base errors and click errors and that that it's gonna deploy nice and that I'm gonna be able to like actually move on to you know working on new features and expanding the functionality and improving the UX and stuff because right now I'm dealing a lot with like putting out the fires of like missing ENV you know keys in CI even though they're fully available and stuff or like things constantly you know AI code going out there and constantly breaking the super base connection and stuff like that. I just want to get to a place where you know I can actually focus on on improving the functionality, improving the user experience and getting you know and and start marketing it to the first set of users and iterating on their feedback and stuff. I want to launch."}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Understood, Mr. White. Concise version: you're on the right track with pre-commit hooks and automated PR merging. For the MVP, focus on ensuring no env key issues, stable Supabase and Clerk connections, and a smooth deployment pipeline. Once that's done, you'll be set to shift focus to features and UX."}
{'asset_pointer': 'sediment://file_0000000096b0622fae1be3ea29117874', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:34:21.188519+00:00', 'format': 'wav', 'metadata': {'end': 20.0, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 960078, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'What are, like, some MVP blockers that you can think of offhand?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000079a8622fb77905a3f13fb188', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:34:57.810373+00:00', 'format': 'wav', 'metadata': {'end': 5.63, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 270318, 'tool_audio_direction': None}, 'audio_start_timestamp': 235.3280222829926, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-19T20:34:57.810373+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Sure, Mr. White. A few quick MVP blockers off the top of my head: First, make sure all environment variables are consistently loaded in all environments. Next, ensure Supabase and Clerk integrations are fully stable and tested end-to-end. Also, confirm your CI pipeline catches any breaking changes early. Once these are locked down, you’ll have a clear path to launch.'}
{'asset_pointer': 'sediment://file_00000000d69c622f923cfa7a9f7ae33d', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:34:57.810523+00:00', 'format': 'wav', 'metadata': {'end': 24.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1154478, 'tool_audio_direction': None}

---

## User

{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000f670622fb10a3284f1398a91', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:35:49.557936+00:00', 'format': 'wav', 'metadata': {'end': 5.74, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 275598, 'tool_audio_direction': None}, 'audio_start_timestamp': 294.56859187099326, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-19T20:35:49.557936+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Okay, that's great. What about, um, what about, uh, UX?"}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Absolutely, Mr. White. In terms of UX, just keep it simple and intuitive for the MVP. Make sure navigation is clear and the profile creation flow is as smooth as possible. If users can sign up, create a profile, and everything feels straightforward, you're good to go."}
{'asset_pointer': 'sediment://file_000000004b5c622fa477ac885369b9bf', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:35:49.558044+00:00', 'format': 'wav', 'metadata': {'end': 17.2, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 825678, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'Are there, like, built-in tests in Storybook that can catch things like state changes causing layout shifts or, like, an extra-long name not fitting within the space of a button or something, or is that something that has to be explicitly coded?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000019c622f83f8bb7cc968caaf', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:36:41.161840+00:00', 'format': 'wav', 'metadata': {'end': 19.84, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 952398, 'tool_audio_direction': None}, 'audio_start_timestamp': 333.7590054600005, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-19T20:36:41.161840+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "You got it, Mr. White. So, Storybook does have some built-in tools for visual testing and checking for things like layout shifts. For example, you can use add-ons like Storybook's Accessibility or Storybook's Visual Regression Testing to catch certain UI issues. But if you're looking for really specific state-related checks—like how a super long name overflows a button—that often does need some custom coding or a bit of extra configuration. So you might have to write those checks explicitly. But Storybook can definitely help"}
{'asset_pointer': 'sediment://file_00000000c9c0622f85dd172cd3ace002', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-19T20:36:41.161934+00:00', 'format': 'wav', 'metadata': {'end': 28.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1368078, 'tool_audio_direction': None}


**Topic:** [[chatgpt-clusters/business_startup]]
