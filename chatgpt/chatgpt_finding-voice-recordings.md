---
title: "Finding Voice Recordings"
type: guide
created: 2026-05-29
updated: 2026-05-29
source: chatgpt-export
conversation_id: 6a19d716-7c0c-83e8-b0f9-cde5fa2ba351
message_count: 2
tags: [chatgpt, import, code]
---
# Finding Voice Recordings

> Conversation ID: 6a19d716-7c0c-83e8-b0f9-cde5fa2ba351
> Created: 2026-05-29T18:12:42Z
> Updated: 2026-05-29T18:18:45Z
> Messages: 2

---

## User

i need to find all the videos of me talking into a pro mic like an sm7 or re20 and download them for triaing data for my voice. 

---

## Assistant

Mr. White, the current YouTube Studio page only shows **videos 31–60 of about 121**, so this is a partial scan.

## Immediate candidates visible on this page

Strong “talking into pro mic” candidates:

| Priority | Title | Date | Duration | Why |
|---:|---|---:|---:|---|
| 1 | **MONETIZE YOUR LIFE** | Jan 23, 2020 | 21:05 | Thumbnail shows you close to a broadcast-style dynamic mic on a boom arm. |
| 2 | **I CAN’T REMEMBER** | Jan 22, 2020 | 4:33 | Thumbnail shows you speaking directly into a pro dynamic mic. |
| 3 | **WE JUST FIGURED IT OUT!!!** | Jan 16, 2020 | 5:49 | Thumbnail shows close-mic speaking setup. |
| 4 | **YouTube Apartment Setup (How I VLOG Proof my NYC Studio)** | Jan 20, 2020 | 19:55 | Description explicitly mentions **Shure SM7b Mic**; likely useful for finding the setup and maybe clean speech sections. |

Secondary / review manually:

| Title | Date | Note |
|---|---:|---|
| **MISSED MY TRAIN!** | Jan 15, 2020 | Looks like studio/mic content, but may be singing/performance rather than clean speech. |
| **How I Got Verified On Instagram (How YOU CAN TOO)** | Jan 14, 2020 | High comment count and talking-head format; mic is not clearly visible from this thumbnail. |

## Download workflow

First, close or cancel any delete dialog/menu. The page context shows a **“Delete forever”** flow is open somewhere, so avoid that path.

For each candidate video:

1. Hover the row.
2. Click the **three-dot menu**.
3. Choose **Download**.

Google’s official YouTube Help says uploaded videos can be downloaded from **YouTube Studio → Content → Menu → Download**, and notes Studio downloads are MP4 files at 720p or 360p depending on size. It also says Google Takeout can download all uploaded videos. citeturn271153view1

## To find all 121

Use two passes:

### Pass 1 — keyword search in Studio

Search these one at a time in **Search across your channel** or the Content filter:

```text
SM7
SM7B
Shure
Shure SM7b
RE20
Electro-Voice
mic
microphone
podcast
studio
voiceover
setup
```

Add any results to a tracker.

### Pass 2 — thumbnail scan

Go page by page:

```text
1–30
31–60
61–90
91–121
```

Flag videos where:

```text
Your mouth is close to a boom-arm dynamic mic
The mic is visible in the thumbnail
The video is mostly solo talking
The audio likely has low room noise
There is little/no music underneath speech
```

Skip or deprioritize:

```text
Outdoor vlogs
Travel/hotel content
Music videos
Singing takes
Videos with other speakers
Videos with background music under speech
```

## Use Google Takeout if bulk download is faster

For a full archive, use **Google Takeout → YouTube and YouTube Music → Videos**. Google Account Help says Takeout can export YouTube videos, and YouTube videos download in original format or as MP4 with H.264 video and AAC audio. It can take minutes to several days depending on account size. citeturn271153view0

## After download: extract voice audio

Use this after collecting the MP4s:

```bash
mkdir wav

for f in *.mp4; do
  ffmpeg -i "$f" -vn -ac 1 -ar 48000 -sample_fmt s16 "wav/${f%.*}.wav"
done
```

Then trim the WAVs into clean solo-speech clips. For voice training, prioritize **close-mic speech only**, with no intro music, no music bed, no guests, and no heavy reverb.


## See Also
- [[chatgpt/chatgpt_ai-imessage-voice-response]]
- [[chatgpt/chatgpt_ai-workflow-for-voice-dictation]]
- [[chatgpt/chatgpt_elevenlabs-voice-ai-grant]]
- [[chatgpt/chatgpt_fiona-voice-cast]]
- [[chatgpt/chatgpt_hermes-voice-interaction-setup]]
