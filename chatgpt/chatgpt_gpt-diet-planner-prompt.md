---
conversation_id: b1c9a742-426b-43cb-a786-bec48563c3a3
created: 2023-11-10
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
title: GPT Diet Planner Prompt
type: note
updated: 2023-11-10
---

# GPT Diet Planner Prompt

**Related:** [[coding_ai]]

> Conversation ID: b1c9a742-426b-43cb-a786-bec48563c3a3
> Created: 2023-11-10T06:14:15Z
> Updated: 2023-11-10T06:14:53Z
> Messages: 2

---

## User

im building a gpt that is a diet planner. Give me a prompt to build it.

I want it to do the following steps in order:

1) get the relevant data from the user like weight, bodyfat, gender and height
2) calculate the users current FFMI.
3) decide what phase to start with:
If the user is near or over 20% body fat we must put them in a cut
If the user is under 10% body fat as a male or 15% bf as a female we must put them in a bulk
If they are within range we should determine if putting them in a cut or bulk for the minimum time will move them out of these ranges and then choose accordingly, else we prompt the user.
4) we tell them they will start phase 1, and it will be either a cut or bulk. Then we predict what their body fat, weight and ffmi will be at the end. We choose a length for the cut based on the safe time ranges, and how close they will get to the safe bf ranges. We also tell them the date they will complete the goal on so they can clearly see that they will be X% bf on Y date.
5) we repeat this process planning out the second phase and predicted their weight, bf% and ffmi based on starting from the results of the previous phase. We continue this until they hit the target ffmi.
6) we display a table to the user with all of the phases listed including:
Number of weeks & Starting & ending date, weight, bf, ffmi


For the rate of change for bodyweight that we will use in the prediction of phases, we will stick to:
.75% for a cut
1% for a minicut
.5% for a bulk


---

## Assistant

Certainly, Mr. White. For constructing a GPT-based diet planner with the outlined functionality, your prompt structure needs to facilitate a sequential data collection and processing approach. Here's a sample prompt that aligns with your requirements:

---

**Prompt for GPT-Based Diet Planner**

1. **Data Collection:**
   - Please enter your current weight (in pounds or kilograms):
   - Please enter your body fat percentage:
   - Please specify your gender (Male/Female):
   - Please enter your height (in feet and inches or centimeters):

2. **FFMI Calculation:**
   - Calculating your Fat-Free Mass Index (FFMI)...

3. **Phase Decision:**
   - Analyzing your data to determine the appropriate phase (Cut/Bulk/Maintenance)...

4. **Phase 1 Planning:**
   - You will start with a [Cut/Bulk] phase.
   - Predicting your body composition at the end of Phase 1...
   - Estimated duration of Phase 1: [X] weeks, completing on [Date].
   - Predicted end-of-phase body fat percentage, weight, and FFMI...

5. **Subsequent Phases:**
   - Planning Phase 2 based on the results of Phase 1...
   - [Repeat this step for each subsequent phase until the target FFMI is reached]

6. **Final Overview:**
   - Displaying a table with all phases:
     - Phase Number
     - Number of Weeks
     - Starting & Ending Date
     - Starting & Ending Weight
     - Starting & Ending Body Fat Percentage
     - Starting & Ending FFMI

---

This prompt structure provides a clear, step-by-step guide for the GPT model to collect relevant user data, perform necessary calculations, and outline the diet plan phases along with predicted outcomes. It also includes a final overview to summarize the plan in a tabular format.


**Topic:** [[chatgpt-clusters/coding_ai]]
