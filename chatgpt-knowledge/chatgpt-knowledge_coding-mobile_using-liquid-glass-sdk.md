---
title: "Using Liquid Glass SDK"
type: guide
created: 2025-07-09
updated: 2025-07-09
source: chatgpt-export
topic: coding-mobile
message_count: 8
tags: [chatgpt, knowledge, coding-mobile]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-mobile]]

# Using Liquid Glass SDK

> **Source:** ChatGPT conversation
> **Date:** 2025-07-09T22:33:49Z
> **Messages:** 8
> **Topic:** coding-mobile

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Yo, so I've got the Apple iOS 26 developer beta version 3 running on my iPhone. I have Xcode version 16 and 16.4 and I'm only seeing in my Xcode the ability for a minimum deployment. We just set iOS 18. I don't see 26 listed there, which is fine because it's just a minimum deployment. But I want to be building with the newest SwiftUI SDK, so I want to take advantage of Liquid Glass so that by the time we roll out iOS 26, our app is fully compatible with the new Liquid Glass design. In fact, I'd love to use the new Liquid Glass design now in iOS 18 as well. Talk to me about what I need to do to get started adding the Liquid Glass to my iOS app and then tell me if those new SDKs can run on iOS 18 if it's in the app or how that works with SwiftUI."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000f60061f6a5415fb3f4d8f0cd', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "So, to start using the new Liquid Glass design from iOS 26 in your app, you'll need to have the iOS 26 SDK installed. Even though your minimum deployment target is iOS 18, you can still use features from newer SDKs conditionally. Essentially, you'll wrap those features in availability checks so that they only run on devices that support iOS 26. If the device is running iOS 18, it will just ignore those features and run the rest of your code as normal.\n\nSo, first make sure you've downloaded the iOS 26 beta SDK in Xcode. Then, in your code, you can use the `#available` directive to check if the device is running iOS 26 before applying any Liquid Glass-specific modifiers. This way, you can start developing and testing the new design now, and your app will still run smoothly on older versions like iOS 18."}
{'asset_pointer': 'sediment://file_00000000798061f6aadabdc7ce20b180', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-05T22:33:49.073661+00:00', 'format': 'wav', 'metadata': {'end': 49.8, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 2390478, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "And is there like, for, if I'm only using, I'm only planning on using right now, the Liquid Glass is the only thing that I'm planning on implementing right now. I'm not planning on implementing any SDK 26 features beyond just UI, so I guess it's just like the new Liquid Glass UI stuff. Is there any kind of default fallback for that, that I can just globally use, or every single time I put in a UI element, do I have to put in an availability check?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000000d061f68470993086a36515', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-05T22:35:04.033122+00:00', 'format': 'wav', 'metadata': {'end': 35.43, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1700718, 'tool_aud

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "If you're only planning to use the Liquid Glass UI features from iOS 26, you will need to add availability checks around any code that specifically uses those features. There isn't really a global fallback that automatically handles that for you, so it's best practice to wrap each Liquid Glass-related element or modifier in an availability check. This way, on devices running iOS 18, the app will just skip those specific features and use your standard UI. It's a little bit of extra code, but it ensures compatibility and a smooth user experience across all supported iOS versions."}
{'asset_pointer': 'sediment://file_00000000508061f6ad0745e1c7dab65f', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-05T22:35:04.033194+00:00', 'format': 'wav', 'metadata': {'end': 36.1, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1732878, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "So are you telling me that anyone who's building an app right now with liquid glass support is having every single element of their UI wrapped in an availability check and then having a second version of that UI built for the older app? That seems extreme."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000001c0c61f6a302e3b72546308a', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-05T22:36:01.484389+00:00', 'format': 'wav', 'metadata': {'end': 20.49, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 983598, 'tool_audio_direction': None}, 'audio_start_timestamp': 232.50189462304115, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-05T22:36:01.484389+00:00', 'frames_asset_

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'I totally get that it sounds a bit extreme, and it can definitely add some complexity. In practice, though, most developers will choose to apply those new features more selectively rather than rewriting the entire UI. So you might have just certain elements or certain views that take advantage of the Liquid Glass design, and those specific elements will have the availability checks. The rest of the UI can remain as it is, using the older design or a more universal approach. This way, you get the best of both worlds without having to duplicate your entire UI.'}
{'asset_pointer': 'sediment://file_00000000d76461f691ae11ea46939555', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-05T22:36:01.484454+00:00', 'format': 'wav', 'metadata': {'end': 35.2, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1689678, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Got it. And how do I go about getting the iOS 26 beta SDK on Xcode? Because I'm only seeing 18.5 listed in my Xcode."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000c49061f696c5cc73d61d7fc8', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-05T22:36:59.896745+00:00', 'format': 'wav', 'metadata': {'end': 22.59, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1084398, 'tool_audio_direction': None}, 'audio_start_timestamp': 292.7674645469524, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-05T22:36:59.896745+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "To get the iOS 26 beta SDK, you'll need to make sure you're enrolled in Apple's Developer Program and have access to the latest developer betas. Once you're signed in, you can go to the Apple Developer website and download the latest Xcode beta, which will include the iOS 26 SDK. Once you install that beta version of Xcode, you'll be able to select iOS 26 as a deployment option and start using those new features. Just keep in mind that the beta versions can have some bugs, so it’s good to keep a stable version of Xcode around as well."}
{'asset_pointer': 'sediment://file_000000000c6061f6b4df1811dd327fae', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-05T22:36:59.896818+00:00', 'format': 'wav', 'metadata': {'end': 34.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1634478, 'tool_audio_direction': None}
