---
title: "Face ID in PWA"
type: note
created: 2025-06-09
updated: 2025-06-09
source: chatgpt-export
conversation_id: 68473454-cf80-8007-a95d-8ef53f9fa0a4
message_count: 16
tags: [chatgpt, import, long-form]
---
# Face ID in PWA

> Conversation ID: 68473454-cf80-8007-a95d-8ef53f9fa0a4
> Created: 2025-06-09T19:22:18Z
> Updated: 2025-06-09T19:30:35Z
> Messages: 16

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'Can I use Face ID on a Progressive Web App, or does it have to be a native iOS app?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000aeb061f68a1da95fc718fcf3', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:22:18.096234+00:00', 'format': 'wav', 'metadata': {'end': 4.03, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 193518, 'tool_audio_direction': None}, 'audio_start_timestamp': 4.269378739991225, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:22:18.096234+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "You can actually use Face ID with a progressive web app! It involves using the WebAuthn API, which allows web apps to use biometric authentication like Face ID. So you don't have to build a native iOS app just to get that feature, which is pretty cool!"}
{'asset_pointer': 'sediment://file_00000000443461f6b3c34603a8766572', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:22:18.096317+00:00', 'format': 'wav', 'metadata': {'end': 14.85, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 712878, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Can I then use the fingerprint scanner on my Mac for login if I'm using a web app?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000a5ac61f6bc95fe4eaf500736', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:22:41.942130+00:00', 'format': 'wav', 'metadata': {'end': 8.9, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 427278, 'tool_audio_direction': None}, 'audio_start_timestamp': 29.979303420055658, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:22:41.942130+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Yep, absolutely! The WebAuthn API also supports using the fingerprint scanner on your Mac, so you can log in to your progressive web app using Touch ID. It’s really convenient and secure, and it works pretty seamlessly!'}
{'asset_pointer': 'sediment://file_000000003b4861f682e0c97d31bedd26', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:22:41.942216+00:00', 'format': 'wav', 'metadata': {'end': 15.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 722478, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Okay, so in my React app that is built on React with TypeScript and Tailwind, that we're planning on wrapping in Capacitor for iOS later, we want it to work on both web and iOS. How should I go about setting up the Touch ID and Face ID stuff?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000c01861f683c7dcbaffa6602d', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:23:32.005981+00:00', 'format': 'wav', 'metadata': {'end': 17.89, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 858798, 'tool_audio_direction': None}, 'audio_start_timestamp': 62.80269530904479, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:23:32.005981+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "To set up Touch ID and Face ID for both the web and the iOS version of your app, you'll want to focus on using the WebAuthn API for the web side. This will let you handle biometric authentication in the browser. For the iOS side, when you wrap your app with Capacitor, you'll use the native iOS biometric APIs. Capacitor has a plugin called `@capacitor/biometrics` that can help you integrate the native biometric authentication. This way, you’ll have a seamless experience on both platforms!"}
{'asset_pointer': 'sediment://file_00000000633461f6a2ab72905a7b4d26', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:23:32.006061+00:00', 'format': 'wav', 'metadata': {'end': 31.25, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1500078, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "If I'm using SuperBizAuth, should I enable it through there, or do I do it myself?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000e41c61f6a31b0ac145cb0774', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:25:07.966576+00:00', 'format': 'wav', 'metadata': {'end': 8.35, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 400878, 'tool_audio_direction': None}, 'audio_start_timestamp': 157.71681228699163, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:25:07.966576+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "If you're using Supabase Auth, you can definitely integrate it with biometric authentication. Supabase doesn't directly handle biometrics on its own, but you can use it alongside the WebAuthn API for the web and the Capacitor biometrics plugin for iOS. Essentially, you'd use Supabase to manage user sessions and authentication on the backend, and then use the biometrics on the front end to securely verify the user before logging them in with Supabase. It works pretty smoothly together!"}
{'asset_pointer': 'sediment://file_00000000f6c061f6a6e2df84c79907a2', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:25:07.966665+00:00', 'format': 'wav', 'metadata': {'end': 30.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1442478, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "So I want to add sign-in with Apple on both desktop and on iOS. When I go to SuperBase and try to enable it, it's asking me for a client ID key."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000000ff061f681961273fc95df96', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:26:26.994875+00:00', 'format': 'wav', 'metadata': {'end': 18.43, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 884718, 'tool_audio_direction': None}, 'audio_start_timestamp': 236.7248166630743, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:26:26.994875+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Yeah, to set up "Sign in with Apple" with Supabase, you\'ll need to create a service ID and get the client ID from Apple. You\'ll also need to set up an Apple developer account if you don\'t have one already. Then, you create a Services ID in the Apple Developer portal, and that Services ID becomes your client ID. You\'ll also need to configure the redirect URLs and get a key ID and a team ID from Apple. Once you have all that info, you plug it into Supabase, and you should be good to go on both desktop and iOS!'}
{'asset_pointer': 'sediment://file_000000002fc061f69cb97dc48253c156', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:26:26.994963+00:00', 'format': 'wav', 'metadata': {'end': 32.35, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1552878, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Okay, I have my developer account, and I'm in the developer portal right now on the homepage of the developer account. Where do I go to get the IDs I need?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000032f061f6aabf9c41827e8663', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:27:18.242695+00:00', 'format': 'wav', 'metadata': {'end': 12.97, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 622638, 'tool_audio_direction': None}, 'audio_start_timestamp': 287.717819232028, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:27:18.242695+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Sure! To get the IDs you need, start by going to the "Certificates, Identifiers & Profiles" section in your Apple Developer account. Once you\'re there, you\'ll want to look for the "Identifiers" section. Under that, you can create a new Services ID, and that will serve as your client ID. You’ll also need to generate a key by going to the "Keys" section and creating a new one. Make sure you enable the "Sign in with Apple" capability for the app. Once you have the Services ID, key ID, and your team ID, you can then plug all of that into Supabase.'}
{'asset_pointer': 'sediment://file_00000000c86861f6849d5c9d3277cb3f', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:27:18.242778+00:00', 'format': 'wav', 'metadata': {'end': 32.65, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1567278, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "I'm on the Web Authentication Configuration page, and it's asking me to add domains and subdomains and return URLs. I've added both of those, but the next button is still grayed out."}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000002d9061f6bef9045fd3a6cf1d', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:30:17.992700+00:00', 'format': 'wav', 'metadata': {'end': 9.51, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 456558, 'tool_audio_direction': None}, 'audio_start_timestamp': 464.6470078220591, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:30:17.992700+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Sometimes that happens if there\'s a small detail missing or if there\'s a formatting issue. Double-check that the return URLs are properly formatted and include the correct protocol, like `https://`. Also, make sure that you\'ve saved any changes and that you\'ve clicked out of the input fields, because sometimes the interface needs a little refresh to recognize that you\'ve entered everything. If everything looks correct and it\'s still not letting you proceed, try refreshing the page or even re-entering the information. That usually helps get that "Next" button active.'}
{'asset_pointer': 'sediment://file_00000000961061f68e36e25ee0a3eb07', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:30:17.992786+00:00', 'format': 'wav', 'metadata': {'end': 35.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1704078, 'tool_audio_direction': None}

---

## User

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "You're talking to me with much more human inflections and stuff. Did you just get an update on your speech?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000f00c61f68bdc79ff97c07bce', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:30:34.787250+00:00', 'format': 'wav', 'metadata': {'end': 5.73, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 275118, 'tool_audio_direction': None}, 'audio_start_timestamp': 507.2146786280209, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2025-12-06T19:30:34.787250+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

---

## Assistant

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "I'm always evolving and trying to sound as natural and friendly as possible! It's great to hear that it comes across that way. If you like it, I'm happy to keep it up!"}
{'asset_pointer': 'sediment://file_00000000e31861f68bffc161d9a66351', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2025-12-06T19:30:34.787332+00:00', 'format': 'wav', 'metadata': {'end': 9.8, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 470478, 'tool_audio_direction': None}


## See Also
- [[chatgpt/chatgpt_face-definitions-and-contexts]]
- [[chatgpt/chatgpt_replace-dall-e-face]]
- [[chatgpt/chatgpt_smiley-face-ascii-art]]
- [[chatgpt/chatgpt_01-vs-091-proof]]
- [[chatgpt/chatgpt_1-of-body-weight-part1]]
