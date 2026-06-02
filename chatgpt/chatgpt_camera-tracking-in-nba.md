---
conversation_id: 68106c51-eb94-8007-afe7-7bc146351ae1
created: 2025-04-29
links:
- '[[chatgpt-clusters/jovie_music_industry]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: Camera Tracking in NBA
type: note
updated: 2025-04-29
---

# Camera Tracking in NBA

> Conversation ID: 68106c51-eb94-8007-afe7-7bc146351ae1
> Created: 2025-04-29T06:06:10Z
> Updated: 2025-04-29T06:06:36Z
> Messages: 2

---

## User

Hey, I'm watching the NBA game and they're, looks like they're like planar tracking the camera moves so that they can overlay the shot clock onto the actual gym floor. Is that done with planar tracking, or is it done with, it looks like it's done with planar tracking, but is it done with accelerometer data in real time, or how are they doing it?

---

## Assistant

They’re not wedging an iPhone in there and using the accelerometer—it’s all done via a “smart” broadcast camera head.  Here’s how it works:

- **Encoded PTZ head + lens metadata:**  The main game camera sits on a pan-tilt-zoom head equipped with high-precision encoders (and sometimes IMUs).  These send real-time pan/tilt/zoom/focus data into the graphics system so it knows exactly where your camera is pointed and how it’s zoomed citeturn1view0turn2view0.  
- **3D court model + planar homography:**  A pre-built 3D model of the flat court (or simple planar homography from detected floor lines) lets the engine compute the correct perspective transform.  Computer-vision routines then fine-tune the fit and handle occlusion by keying the players out of the way citeturn3view0.  

No consumer-grade accelerometer needed—precision comes from the encoded head and lens encoders feeding the graphics engine.


**Topic:** [[chatgpt-clusters/jovie_music]]
