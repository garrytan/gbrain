
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'Okay, so what I would like you to do now is take my current stats, 165 pounds, and 6\'4", and 11% body fat. I\'d like you to make a table, and in that table I\'d like you to have a column for my weight. I\'d like you to make a column for my FFMI, and then for my – no, I guess I just need the FFMI and the weight. And then what I\'d like you to do is calculate – basically – and then I guess you could do lean body mass in another column. And what I would like to do is I would like you to mark out 17 FFMI, 18 FFMI, 19 FFMI, you know, etc. on me, and assuming we maintain that 11% body fat, what that would look like in terms of – I want to know my weight at each FFMI, right? So if I\'m currently at whatever I\'m currently at, and then the next FFMI up, and then keep going all the way up to 23.'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_000000009da061f6aca12cbe06e6db7a', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T20:51:46.408610+00:00', 'format': 'wav', 'metadata': {'end': 87.26, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 4188558, 'tool_audio_direction': None}, 'audio_start_timestamp': 273.5854228939861, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-20T20:51:46.408610+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'I can definitely help you figure out what your weight and lean body mass would look like at different FFMI levels. Let me put that together for you and give you a rough estimate of what that progression would look like.'}
{'asset_pointer': 'sediment://file_00000000c5bc61f6ba4966efaa12e535', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T20:51:46.408680+00:00', 'format': 'wav', 'metadata': {'end': 13.35, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 640878, 'tool_audio_direction': None}


Shore me


Mr. White, here you go—assumes **11% BF constant**, height = **6'4" (1.930 m; h² = 3.726)**.

| FFMI | LBM (lb) | Weight @ 11% BF (lb) |
|-----:|---------:|---------------------:|
| 17.0 | 139.7 | 156.9 |
| **17.9 (now)** | **146.9** | **165.0** |
| 18.0 | 147.9 | 166.2 |
| 19.0 | 156.1 | 175.4 |
| 20.0 | 164.3 | 184.6 |
| 21.0 | 172.5 | 193.8 |
| 22.0 | 180.7 | 203.1 |
| 23.0 | 189.0 | 212.3 |

Formula used:  
FFMI = (LBM_kg) / h² → LBM_lb = FFMI × h² × 2.20462  
Weight = LBM / (1 − BF)

Need other BF%s or a CSV, shout.


What I'd like you to do now, give me the same chart in a new column, put plus and then the number of pounds of muscle that would have been gained from what I currently am.


Mr. White—added a “+ Muscle vs Now” column (current LBM = **146.99 lb**, FFMI ≈ **17.9**). Assumes **11% BF stays constant**.

| FFMI | LBM (lb) | Weight @ 11% (lb) | + Muscle vs Now (lb) |
|-----:|---------:|-------------------:|---------------------:|
| 17.0 | 139.6 | 156.9 | –7.4 |
| **17.9 (now)** | **147.0** | **165.2** | **+0.0** |
| 18.0 | 147.8 | 166.1 | +0.8 |
| 19.0 | 156.0 | 175.3 | +9.0 |
| 20.0 | 164.2 | 184.5 | +17.2 |
| 21.0 | 172.5 | 193.8 | +25.5 |
| 22.0 | 180.7 | 203.0 | +33.7 |
| 23.0 | 188.9 | 212.2 | +41.9 |

Need different BF% columns or CSV? Say the word.


I want you to do the same thing, but I want to change the weight to weight at 8% body fat.


Mr. White—same chart, **weight column = weight at 8% BF** (Weight = LBM / 0.92).  
Assumptions: height 6'4" (h²=3.7249), current = **165 lb @ 11% → LBM 147.0 lb, FFMI ≈ 17.9**.

| FFMI | LBM (lb) | Wt @ 8% BF (lb) | + Muscle vs Now (lb) |
|-----:|---------:|----------------:|---------------------:|
| 17.0 | 139.6 | 151.7 | –7.4 |
| **17.9 (now)** | **147.0** | **159.8** | **0.0** |
| 18.0 | 147.8 | 160.7 | +0.8 |
| 19.0 | 156.0 | 169.6 | +9.0 |
| 20.0 | 164.2 | 178.5 | +17.2 |
| 21.0 | 172.5 | 187.4 | +25.5 |
| 22.0 | 180.7 | 196.4 | +33.7 |
| 23.0 | 188.9 | 205.3 | +41.9 |

Need other BF% columns or a CSV? Say the word.


According to Mike Izrutel, he has some recommendations on how much muscle a natural lifter can gain each year. He has a progression where he says in the first year or two, a beginner can gain X amount, and an intermediate can gain X amount, and an advanced can gain X amount. I'd like you to basically give me back the same table, but instead of incrementing by FFMI, increment by muscle gains per year. So if he says that you can gain a pound of muscle in your first year, increment by a pound on the first one. Then if he says you can gain by a pound the second year, increment by a pound on the second one. And if he says you can gain half a pound the third year, increment by half a pound on the third one, etc. But use what Mike Izrutel actually recommends or says that on average natural lifters can gain.


Mr. White—Israetel’s own ranges (natty males): ~0.1–0.5 lb muscle/week for true noobs (avg ≈0.2), dropping to ~0.1, then ~0.05, then ~0.02–0.03 as you advance. Yearly that’s roughly **10, 5, 2.5, 1.3 lb**. I used those midpoints. citeturn1search0turn1search9

**Assumptions**
- Current: 165 lb @ 11% → LBM = 147.0 lb, FFMI ≈ 17.9 (h² = 3.7249).  
- Weight column = weight at **8% BF** (Wt = LBM / 0.92).  
- Gains are pure muscle (no LBM loss).

| Year | Stage (per MI) | LBM (lb) | Wt @ 8% (lb) | FFMI | + Muscle vs Now (lb) |
|----:|-----------------|---------:|-------------:|-----:|---------------------:|
| 0   | Now             | 147.0 | 159.8 | 17.9 | 0.0 |
| 1   | Noob-ish (~10 lb) | 157.4 | 171.1 | 19.2 | +10.4 |
| 2   | Intermediate (~5 lb) | 162.6 | 176.7 | 19.8 | +15.6 |
| 3   | Advanced (~2.5 lb) | 165.2 | 179.6 | 20.1 | +18.2 |
| 4   | Elite (~1.3 lb) | 166.5 | 181.0 | 20.3 | +19.5 |

Want different BF% columns, a CSV, or to swap in the *upper* or *lower* ends of Mike’s ranges? Say the word.


And what would a noob FFMI be considered? What would an intermediate FFMI be considered?


Rough natty FFMI tiers (not gospel, but useful):

- **Noob / untrained:** ~15–18  
- **Intermediate:** ~18–20  
- **Advanced:** ~20–22  
- **Elite natty outliers:** ~22–23  
- **Likely enhanced:** >23–24+

You’re ~17.9 now → edge of noob/intermediate.


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Alright, so let's assume I'm 166 at 166, or let's say I'm 165 pounds and 11% body fat. What does it take to get me down to 6%?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000170461f6853d647a5da068aa', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:06:43.931750+00:00', 'format': 'wav', 'metadata': {'end': 14.95, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 717678, 'tool_audio_direction': None}, 'audio_start_timestamp': 17.382653810083866, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-20T21:06:43.931750+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': "To get from 11% body fat down to 6%, you'd be looking at losing a good portion of body fat. If you're currently around 165 pounds at 11% body fat, that means you have about 18 pounds of fat. To get down to 6%, you'd reduce that fat to about 10 pounds, so you'd need to lose roughly 8 pounds of pure fat. That would put your weight around 157 pounds if you maintain the same amount of lean mass."}
{'asset_pointer': 'sediment://file_00000000ac5c61f68533014c4d4a376b', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:06:43.931810+00:00', 'format': 'wav', 'metadata': {'end': 28.4, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1363278, 'tool_audio_direction': None}


{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000e7c861f6b1781e53c7d4b74f', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:07:33.639908+00:00', 'format': 'wav', 'metadata': {'end': 27.1, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1300878, 'tool_audio_direction': None}, 'audio_start_timestamp': 77.06577173713595, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-20T21:07:33.639908+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}
{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Let's say I do it. Let's say I get down to 6%. Let's say I gain up to 12% of fat and muscle, shed 6% fat in a cut, puts me at 163 at 6% body fat. What does my FFMI look like then?"}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'If you get down to 6% body fat at around 163 pounds, that would mean your lean body mass is about 153 pounds. Using that lean mass and factoring in your height, your FFMI would be around 20. So that would put you in a pretty solid intermediate-to-advanced range.'}
{'asset_pointer': 'sediment://file_000000008a0461f6aeace2a254066a93', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:07:33.639973+00:00', 'format': 'wav', 'metadata': {'end': 19.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 936078, 'tool_audio_direction': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'Can you double-check that? My FFMI would be 20.'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000006b461f68ef3cf7cb9d2bb95', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:08:16.699998+00:00', 'format': 'wav', 'metadata': {'end': 3.27, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 157038, 'tool_audio_direction': None}, 'audio_start_timestamp': 111.21770657412708, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-20T21:08:16.699998+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Sure, let\'s break it down again to double-check. If you\'re at 163 pounds and 6% body fat, that means your lean body mass is about 153 pounds. Using that lean mass and your height of 6\'4", your FFMI would actually be closer to around 21. That would definitely put you in the advanced range, which is pretty impressive!'}
{'asset_pointer': 'sediment://file_00000000de9061f6b3a875e01dbb378c', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:08:16.700071+00:00', 'format': 'wav', 'metadata': {'end': 22.05, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 1058478, 'tool_audio_direction': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': "Let's walk through this again. I'm 165 pounds and 11% body fat. What's my FFMI currently?"}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_00000000d91c61f691f6a708ffaf815b', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:08:52.941240+00:00', 'format': 'wav', 'metadata': {'end': 8.29, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 397998, 'tool_audio_direction': None}, 'audio_start_timestamp': 156.48506107134745, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-20T21:08:52.941240+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'Sure! Let\'s calculate it step-by-step. At 165 pounds and 11% body fat, your lean body mass would be about 147 pounds. Using that lean mass and your height of 6\'4", your current FFMI would be around 17.9, which is already a solid number!'}
{'asset_pointer': 'sediment://file_00000000714861f6b798e6888c7a42f5', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:08:52.941307+00:00', 'format': 'wav', 'metadata': {'end': 19.8, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 950478, 'tool_audio_direction': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'in', 'text': 'And if I add 6 pounds of muscle, my FFMI becomes...'}
{'audio_asset_pointer': {'asset_pointer': 'sediment://file_0000000070bc61f68aacda95d359d7d5', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:09:06.891341+00:00', 'format': 'wav', 'metadata': {'end': 3.85, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 184878, 'tool_audio_direction': None}, 'audio_start_timestamp': 182.25755009800196, 'content_type': 'real_time_user_audio_video_asset_pointer', 'expiry_datetime': '2026-01-20T21:09:06.891341+00:00', 'frames_asset_pointers': [], 'video_container_asset_pointer': None}


{'content_type': 'audio_transcription', 'decoding_id': None, 'direction': 'out', 'text': 'If you add 6 pounds of muscle, that would bring your lean body mass up to about 153 pounds. Keeping your body'}
{'asset_pointer': 'sediment://file_00000000bffc61f680c221c02fd95101', 'content_type': 'audio_asset_pointer', 'expiry_datetime': '2026-01-20T21:09:06.891415+00:00', 'format': 'wav', 'metadata': {'end': 5.5, 'end_timestamp': None, 'interruptions': None, 'original_audio_source': None, 'pretokenized_vq': None, 'start': 0.0, 'start_timestamp': None, 'transcription': None, 'word_transcription': None}, 'size_bytes': 264078, 'tool_audio_direction': None}


And what would my FFMRI be then?


~**18.6 FFMI** (6 lb muscle added).

Calc:  
LBM = 147 + 6 = 153 lb → 69.4 kg  
FFMI = 69.4 ÷ (1.93²) = 69.4 ÷ 3.7249 ≈ **18.6**.

(“FFMRI” = typo—FFMI.)


OK, so what I would like now is I’m 166 sorry I’m 165 pounds on 11% body fat. I’m 6 foot four. I’d like you to make a table that shows my current FMI my current weight and my currently in body mass and then each row is incrementing one FFMI showing what that would be and then also having a column that shows how many pounds additional is for my current


Mr. White—assumes **11% BF stays constant**.

| FFMI | LBM (lb) | Weight @ 11% (lb) | +LBM vs Now (lb) |
|-----:|---------:|-------------------:|-----------------:|
| **17.9 (now)** | **146.9** | **165.0** | **0.0** |
| 18 | 147.8 | 166.1 | +0.9 |
| 19 | 156.0 | 175.3 | +9.1 |
| 20 | 164.2 | 184.5 | +17.3 |
| 21 | 172.4 | 193.7 | +25.5 |
| 22 | 180.6 | 203.0 | +33.7 |
| 23 | 188.8 | 212.2 | +41.9 |

(“+LBM” = added muscle/lean mass vs your current 146.9 lb LBM.) Need 8% BF or other increments, say so.
