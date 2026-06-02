---
conversation_id: 6851b94a-22f0-8007-ac4e-f407888890ab
created: 2025-06-17
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 12
source: chatgpt-export
tags:
- chatgpt
- import
title: Wireframe Human Torso
type: note
updated: 2025-06-17
---

# Wireframe Human Torso

> Conversation ID: 6851b94a-22f0-8007-ac4e-f407888890ab
> Created: 2025-06-17T18:51:54Z
> Updated: 2025-06-17T19:00:48Z
> Messages: 12

---

## User

Generate a futuristic-looking white wireframe of a human at 5% body fat. Male. Show me just their torso. White on black.

---

## Assistant

Here’s the futuristic white wireframe of a male torso at 5% body fat, shown in stark white lines against a deep black background to highlight every detail of the musculature. Let me know if you’d like any tweaks—angle, line thickness, or additional sci-fi elements.

---

## User

Now generate the same exact image, but at 10% body fat.

---

## Assistant

Here’s the white wireframe of a male torso at 10% body fat in the same futuristic style—white grid lines on a black background highlighting slightly softer muscle contours. Let me know if you’d like any adjustments.

---

## User

Now generate the same image at 15% body fat.

---

## Assistant

Here’s the white wireframe of a male torso at 15% body fat—same futuristic grid style against black, with muscles showing a bit more softness under the added fat layer. Let me know if you want further tweaks.

---

## User

Now generate the same image at 20% body fat.

---

## Assistant

Here’s the white wireframe of a male torso at 20% body fat, maintaining the same futuristic grid aesthetic on a black background. Let me know if you’d like any changes!

---

## User

Now do the same exact image at 25% body fat.

---

## Assistant

Here’s the white wireframe of a male torso at 25% body fat—same futuristic grid style on a black background. Let me know if you’d like any further adjustments!

---

## User

Okay, now we need to ask Claude to use the OpenAI API to do the same thing one by one for every single image of all 5% body fat variants between 5% and 50% for both male and female, for FFMIs of 15, 17.5, 20, 22.5, and 25. And then to save all of those images into a folder in our project so that we can replace our avatars with them.

---

## Assistant

I’ve provided a Python script that iterates through every combination of gender, FFMI, and body-fat percentage, calls the OpenAI Image API with the corresponding prompt, and saves each image into an `avatars/` folder. You can install the required `openai` and `requests` packages (`pip install openai requests`), set your `OPENAI_API_KEY` environment variable, and run this script in your project directory.


**Topic:** [[chatgpt-clusters/design_ux]]
