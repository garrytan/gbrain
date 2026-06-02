---
title: "CI setup advice"
type: guide
created: 2025-09-01
updated: 2025-09-01
source: chatgpt-export
topic: coding-ai
message_count: 18
tags: [chatgpt, knowledge, coding-ai]
---
# CI setup advice

> **Source:** ChatGPT conversation
> **Date:** 2025-09-01T15:45:03Z
> **Messages:** 18
> **Topic:** coding-ai

## Question

{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000020461f68505597c4a3f7d6b', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:45:02.750848+00:00', 'format': 'wav', 'metadata': {'end': 163.1, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 7828878, 'tool_audio_direction': None}, 'audio_start_timestamp': 165.42160527099622, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:45:02.750848+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "All right, dude. So, Monjoby, in an effort to keep everything running efficiently and smooth, I think one of our AI agents in one of our issues, when they were working on it, decided it was a good idea to

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Sure, Mr. White. In short: If you have zero users right now and you're just pre-launch, you can skip the Redis caching for the moment. Keep your CI and deployment process as simple as possible. Once you have actual traffic or real users, you can add caching later. So the best move is to avoid the complexity now and focus on shipping features quickly."}
{'asset_pointer': 'sediment://file_000000003f3061f6a234b457935d8d76', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:45:02.750917+00:00', 'format': 'wav', 'metadata': {'end': 21.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1032078, 'tool_audio_direction': None}

## Question

{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000be5c61f695c7920ae9c95e25', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:45:52.967957+00:00', 'format': 'wav', 'metadata': {'end': 13.6, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 652878, 'tool_audio_direction': None}, 'audio_start_timestamp': 229.31286542699672, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:45:52.967957+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "In terms of like Neon and like the DB and stuff, what should be the flow for us to do development with Neon and Drizzle so that we're never"}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Absolutely, Mr. White.'}
{'asset_pointer': 'sediment://file_0000000062cc61f6a26e779512e98c5d', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:45:52.968027+00:00', 'format': 'wav', 'metadata': {'end': 0.1, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 4878, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': ''}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000453461f6a68736fce06fce69', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:46:12.760106+00:00', 'format': 'wav', 'metadata': {'end': 5.73, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 275118, 'tool_audio_direction': None}, 'audio_start_timestamp': 235.9824291059631, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:46:12.760106+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Got it, Mr. White. Concisely put: keep your production database completely separate and stable. For development with Neon and Drizzle, just use a dedicated dev or preview database that you can freely break or reset. Basically, never let development changes touch the production environment directly. That way production stays stable and you can iterate quickly in development.'}
{'asset_pointer': 'sediment://file_00000000e95461f6a33e8a9aaa8b8cb2', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:46:12.760180+00:00', 'format': 'wav', 'metadata': {'end': 22.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1058478, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'And should my branches that are being spun up all be children of production? And then, for our staging site, should that have its own branch? Or, like, how should we do it?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000006ccc61f6ac61854c490bcd72', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:46:59.637618+00:00', 'format': 'wav', 'metadata': {'end': 14.69, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 705198, 'tool_audio_direction': None}, 'audio_start_timestamp': 276.16837886098074, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:46:59.637618+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Sure thing, Mr. White. In a nutshell: your feature branches can be spun off from your main branch, which is stable and close to production. For staging, it’s usually best to have a dedicated staging environment that mirrors production but is separate. That way you test everything there before promoting it to production and keep production clean. So in short, yes, have staging as its own branch or environment, and let feature branches come off your main branch.'}
{'asset_pointer': 'sediment://file_000000007e3861f68e10d72e82ae831b', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:46:59.637685+00:00', 'format': 'wav', 'metadata': {'end': 28.55, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1370478, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "So would you say that we should have our staging site with a dedicated branch that's a child of production, and then for each one of our feature branches, have a DB that's a child of our staging site?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000eb3861f6ae31169d89463fc6', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:47:56.055136+00:00', 'format': 'wav', 'metadata': {'end': 18.43, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 884718, 'tool_audio_direction': None}, 'audio_start_timestamp': 340.7005479490035, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:47:56.055136+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Exactly, Mr. White. In a nutshell: yes, you can have a staging branch as a child of production, and then each feature branch can have its own DB derived from staging. That way, you keep things nice and isolated, and your staging environment closely mirrors production. It’s a clean approach that keeps production stable.'}
{'asset_pointer': 'sediment://file_00000000417c61f692f05a5b77681856', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:47:56.055207+00:00', 'format': 'wav', 'metadata': {'end': 19.9, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 955278, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "And then, would we always be using production data in development then, if they'd be cloning the data?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000023dc61f697ccaacb946a866c', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:48:37.136607+00:00', 'format': 'wav', 'metadata': {'end': 8.71, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 418158, 'tool_audio_direction': None}, 'audio_start_timestamp': 374.4570594760007, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:48:37.136607+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "In short, Mr. White, not necessarily. It's often better to use a sanitized or smaller dataset in development rather than cloning production data directly. That way you protect sensitive information and keep things lean. So you can refresh your staging or development databases with a subset of production data or mock data that's still realistic. In other words, no need to always clone the full production data for development."}
{'asset_pointer': 'sediment://file_00000000d52861f68d4bc96fe30a5b89', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:48:37.136676+00:00', 'format': 'wav', 'metadata': {'end': 28.75, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1380078, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'And how does NEON handle that? Like, how would we go about setting up that, um, those, uh, child branches with data?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000893061f6add4b7d78291440a', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:49:29.141192+00:00', 'format': 'wav', 'metadata': {'end': 14.14, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 678798, 'tool_audio_direction': None}, 'audio_start_timestamp': 418.48483504599426, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:49:29.141192+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Sure, Mr. White. In a nutshell, with Neon, you can create branch-based databases that effectively act like child copies of your main database. You can configure them to initialize with a subset of your production data or with sanitized data. Neon handles branching at the database level pretty smoothly, so you can spin up those branches for each feature and load them with the appropriate data set. Basically, you just set up your branching strategy in Neon’s interface, decide what data to include, and you're good to go. It’s designed to keep your production stable while you work on features."}
{'asset_pointer': 'sediment://file_00000000ead061f68b61458556e60f06', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:49:29.141257+00:00', 'format': 'wav', 'metadata': {'end': 35.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1704078, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'And then, is cloning a subset of the data something that NEON handles, or is that something that we would code in ourselves?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000003a861f68a179b377f0cebeb', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:50:02.964611+00:00', 'format': 'wav', 'metadata': {'end': 7.97, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 382638, 'tool_audio_direction': None}, 'audio_start_timestamp': 463.7296649540076, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:50:02.964611+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "Certainly, Mr. White. In a nutshell: Neon mainly handles the branching itself, but if you want to clone only a specific subset of data, you'd typically set that up yourself. In other words, you'd write a bit of code or a script to populate the development or staging branch with only the data you need. So Neon gives you the branching capability, and you customize what data goes into those branches."}
{'asset_pointer': 'sediment://file_00000000730861f6b3abdc960b983550', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:50:02.964675+00:00', 'format': 'wav', 'metadata': {'end': 24.9, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1195278, 'tool_audio_direction': None}

## Question

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'If I wanted to use all the data, just, like, do a direct clone, can Neon handle that?'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000f2ac61f687e393c3396b9834', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:50:36.240961+00:00', 'format': 'wav', 'metadata': {'end': 7.62, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 365838, 'tool_audio_direction': None}, 'audio_start_timestamp': 497.8639345369884, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-02-28T15:50:36.240961+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}

## Answer

{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Yes, Mr. White, absolutely. In short: Neon can handle a direct full clone of your data without any extra coding on your side. If you want to just duplicate the entire production data set into a staging or development branch, Neon makes that straightforward. So if you just need an exact replica, Neon can clone the full database for you directly.'}
{'asset_pointer': 'sediment://file_00000000cddc61f6b87569fb11e70451', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-02-28T15:50:36.241024+00:00', 'format': 'wav', 'metadata': {'end': 21.85, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1048878, 'tool_audio_direction': None}
