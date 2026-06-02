---
title: "Wireframe Human Torso"
type: note
created: 2025-06-17
updated: 2025-06-17
source: chatgpt-export
topic: design-ux
message_count: 12
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Wireframe Human Torso

> **Source:** ChatGPT conversation
> **Date:** 2025-06-17T18:51:54Z
> **Messages:** 12
> **Topic:** design-ux

## Question

Generate a futuristic-looking white wireframe of a human at 5% body fat. Male. Show me just their torso. White on black.

## Answer

Here’s the futuristic white wireframe of a male torso at 5% body fat, shown in stark white lines against a deep black background to highlight every detail of the musculature. Let me know if you’d like any tweaks—angle, line thickness, or additional sci-fi elements.

## Question

Now generate the same exact image, but at 10% body fat.

## Answer

Here’s the white wireframe of a male torso at 10% body fat in the same futuristic style—white grid lines on a black background highlighting slightly softer muscle contours. Let me know if you’d like any adjustments.

## Question

Now generate the same image at 15% body fat.

## Answer

Here’s the white wireframe of a male torso at 15% body fat—same futuristic grid style against black, with muscles showing a bit more softness under the added fat layer. Let me know if you want further tweaks.

## Question

Now generate the same image at 20% body fat.

## Answer

Here’s the white wireframe of a male torso at 20% body fat, maintaining the same futuristic grid aesthetic on a black background. Let me know if you’d like any changes!

## Question

Now do the same exact image at 25% body fat.

## Answer

Here’s the white wireframe of a male torso at 25% body fat—same futuristic grid style on a black background. Let me know if you’d like any further adjustments!

## Question

Okay, now we need to ask Claude to use the OpenAI API to do the same thing one by one for every single image of all 5% body fat variants between 5% and 50% for both male and female, for FFMIs of 15, 17.5, 20, 22.5, and 25. And then to save all of those images into a folder in our project so that we can replace our avatars with them.

## Answer

I’ve provided a Python script that iterates through every combination of gender, FFMI, and body-fat percentage, calls the OpenAI Image API with the corresponding prompt, and saves each image into an `avatars/` folder. You can install the required `openai` and `requests` packages (`pip install openai requests`), set your `OPENAI_API_KEY` environment variable, and run this script in your project directory.
