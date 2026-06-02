---
title: "Fitness Tracking and Plan"
type: guide
created: 2023-11-16
updated: 2023-11-16
source: chatgpt-export
topic: personal-life
message_count: 11
tags: [chatgpt, knowledge, personal-life]
---
**Topic:** [[chatgpt-knowledge/_topics/personal-life]]

# Fitness Tracking and Plan

> **Source:** ChatGPT conversation
> **Date:** 2023-11-16T03:09:27Z
> **Messages:** 11
> **Topic:** personal-life

## Question

Week	Phase		Date Start	Date End	Weight (LBs)	Rate	LBM (LBs)	BF (Dexa)	LBM (Scale)	BF (Scale)	FFMI	Height
0	Start				184.60			20.00%		11.80%		
1	Cut	1	11/15/2023	11/22/2023	182.75	-1%	147.68	20.00%		11.80%	17.98	1.93
2	Cut	2	11/22/2023	11/29/2023	180.93	-1%	147.68	18.38%		18.38%	17.98	1.93
3	Cut	3	11/29/2023	12/6/2023	179.12	-1%	147.68	17.55%		17.55%	17.98	1.93
4	Cut	4	12/6/2023	12/13/2023	177.33	-1%	147.68	16.72%		16.72%	17.98	1.93
5	Cut	5	12/13/2023	12/20/2023	175.55	-1%	147.68	15.88%		15.88%	17.98	1.93
6	Cut	6	12/20/2023	12/27/2023	173.80	-1%	147.68	15.03%		15.03%	17.98	1.93
7	Cut	7	12/27/2023	1/3/2024	172.06	-1%	147.68	14.17%		14.17%	17.98	1.93
8	Cut	8	1/3/2024	1/10/2024	170.34	-1%	147.68	13.30%		13.30%	17.98	1.93
9	Cut	9	1/10/2024	1/17/2024	168.64	-1%	147.68	12.43%		12.43%	17.98	1.93
10	Cut	10	1/17/2024	1/24/2024	166.95	-1%	147.68	11.54%		11.54%	17.98	1.93
11	Cut	11	1/24/2024	1/31/2024	165.28	-1%	147.68	10.65%		10.65%	17.98	1.93
12	Cut	12	1/31/2024	2/7/2024	163.63	-1%	147.68	9.75%	

## Answer

It seems you've provided a detailed body composition tracking chart, outlining a fitness plan that includes phases of cutting, bulking, mini-cuts, and maintenance over a span of several years. This chart includes metrics like weight, lean body mass (LBM), body fat percentage (both from DEXA and scale readings), and fat-free mass index (FFMI). It's designed to track changes in body composition over time, aligning with specific fitness goals.

The plan shows a pattern of gradual weight loss during cutting phases, with corresponding reductions in body fat percentage. During bulking phases, there's an increase in weight and lean body mass, with a slight increase in body fat. Mini-cuts seem to be short periods of more intense weight loss, presumably to trim body fat gained during bulking. Maintenance phases aim to stabilize weight and body composition.

This kind of tracking is useful for athletes or individuals focused on bodybuilding or physique transformation, as it allows for close monitoring of changes in body composition. It’s a strategic approach to achieve specific physical goals while maintaining muscle mass and overall health. 

If you have specific questions or need advice on how to optimize this plan, feel free to ask!

## Question

how do i calculate the lean body mass for the scale.
It should be based on the weight change. if were losing weight assume we lost all fat if were gaining assume 1:1 fat/muscle, else assume no change

## Answer

To calculate lean body mass (LBM) using your scale and the assumptions you've provided, you'll follow different methods depending on whether you're in a weight loss (cutting), weight gain (bulking), or maintenance phase. Here's how you can do it:

1. **During Weight Loss (Cutting Phase)**:
   - Assume all weight lost is fat.
   - To calculate LBM, simply keep it constant from the starting point as long as you're losing weight. Your LBM doesn't decrease if you're assuming all lost weight is fat.

2. **During Weight Gain (Bulking Phase)**:
   - Assume the weight gained is a 1:1 ratio of fat to muscle.
   - For every pound gained, increase your LBM by 0.5 pounds.
   - For example, if you gain 2 pounds, 1 pound is assumed to be muscle (added to your LBM) and 1 pound is fat.

3. **During Maintenance Phase**:
   - If your weight doesn't change, your LBM remains the same as the last recorded value.

To start with, you'll need your initial LBM. If you don't have an exact measurement, you can estimate it. For example, if your initial body fat percentage (BF%) is known, you can estimate your initial LBM as follows:

\[ \text{Initial LBM} = \text{Initial Weight} \times (1 - \text{Initial BF%}) \]

Let's say your initial weight is 184.6 lbs and your initial body fat percentage is 20%. Your initial LBM would be calculated as follows:

\[ \text{Initial LBM} = 184.6 \times (1 - 0.20) \]

Let's calculate that:

## Answer

Your initial lean body mass (LBM) is 147.68 lbs. 

Now, as you progress through your fitness plan, you'll adjust your LBM based on the rules we discussed:

- During cutting phases, your LBM remains at 147.68 lbs.
- During bulking phases, for every pound you gain, add 0.5 lbs to the LBM.
- During maintenance phases, your LBM remains constant at its latest value.

Remember, this is a simplified model and actual body composition changes can be more complex, potentially involving changes in lean mass even during weight loss or gain. It's also important to note that factors like exercise type, diet, and individual physiology play a significant role in how muscle and fat are gained or lost.

## Question

what do i put in google sheets

## Answer

To track your Lean Body Mass (LBM) in Google Sheets based on the rules you've set (losing weight = all fat loss, gaining weight = 1:1 fat/muscle gain, maintenance = no change), you can create a formula that automatically updates your LBM based on your current weight and the phase you are in. Here's a step-by-step guide:

1. **Set Up Your Columns**: 
   - A: Week
   - B: Phase (e.g., Cut, Bulk, Maintenance)
   - C: Date Start
   - D: Date End
   - E: Weight (LBs)
   - F: Change in Weight (calculated)
   - G: LBM (calculated)

2. **Enter Initial Data**:
   - For Week 0, enter your initial weight and initial LBM (which we calculated as 147.68 lbs).

3. **Calculate Weekly Weight Change**:
   - In column F (starting from week 1), use the formula to calculate the weekly weight change:
     \[ F2 = E2 - E1 \] 
   - Drag this formula down the column to apply it to all weeks.

4. **Calculate LBM**:
   - In column G (starting from week 1), use an IF formula to adjust LBM based on the phase:
     - For Cutting: If weight decreases, LBM stays the same.
     - For Bulking: If weight increases, half of the weight gain is added to LBM.
     - For Maintenance: LBM remains unchanged.
   - Example formula for cell G2 (assuming G1 has initial LBM):
     \[ \text{=IF}(B2="Cut", G1, IF(B2="Bulk", G1 + F2/2, IF(B2="Maintenance", G1, ""))) \]
   - Drag this formula down to apply it to all subsequent rows.

5. **Auto-Fill for Efficiency**:
   - You can drag the corner of the cell containing the formula down the column to automatically fill the formula for all rows.

6. **Adjust as Needed**:
   - Be sure to update your sheet regularly with your current weight and phase for accurate tracking.

This setup will allow Google Sheets to automatically calculate and update your LBM based on your current weight and the phase of your fitness plan. Remember, these calculations are based on general assumptions and may not reflect the exact physiological changes in your body.

## Question

Week	Phase		Date Start	Date End	Weight (LBs)	Rate	LBM (LBs)	BF (Dexa)	LBM (Scale)	BF (Scale)	FFMI	Height
0	Start				184.60			20.00%		11.80%		
1	Cut	1	11/15/2023	11/22/2023	182.75	-1%	147.68	20.00%	162.82	11.80%	17.98	1.93
2	Cut	2	11/22/2023	11/29/2023	180.93	-1%	147.68	18.38%		18.38%	17.98	1.93
3	Cut	3	11/29/2023	12/6/2023	179.12	-1%	147.68	17.55%		17.55%	17.98	1.93
4	Cut	4	12/6/2023	12/13/2023	177.33	-1%	147.68	16.72%		16.72%	17.98	1.93
5	Cut	5	12/13/2023	12/20/2023	175.55	-1%	147.68	15.88%		15.88%	17.98	1.93
6	Cut	6	12/20/2023	12/27/2023	173.80	-1%	147.68	15.03%		15.03%	17.98	1.93
7	Cut	7	12/27/2023	1/3/2024	172.06	-1%	147.68	14.17%		14.17%	17.98	1.93
8	Cut	8	1/3/2024	1/10/2024	170.34	-1%	147.68	13.30%		13.30%	17.98	1.93
9	Cut	9	1/10/2024	1/17/2024	168.64	-1%	147.68	12.43%		12.43%	17.98	1.93
10	Cut	10	1/17/2024	1/24/2024	166.95	-1%	147.68	11.54%		11.54%	17.98	1.93
11	Cut	11	1/24/2024	1/31/2024	165.28	-1%	147.68	10.65%		10.65%	17.98	1.93
12	Cut	12	1/31/2024	2/7/2024	163.63	-1%	147.68	

## Answer

To calculate the Lean Body Mass (LBM) using a scale in Google Sheets, based on your criteria (losing weight = all fat loss, gaining weight = 1:1 fat/muscle gain, maintenance = no change), you need to use a formula that updates the LBM based on weight changes. Here's how to set it up:

1. **Set Up Your Spreadsheet**: 
   - Use the columns you have, with an additional column for calculating LBM based on the scale. Let's say this is column H ("LBM (Scale)").

2. **Initial LBM**:
   - Enter your initial LBM value in the first row of column H.

3. **Calculate LBM for Each Week**:
   - In column H, starting from the second row (H2), use the following formula:
     - `=IF(B2="Cut", H1, IF(B2="Bulk", H1 + (E2 - E1)/2, IF(B2="Maintenance", H1, "")))`
   - This formula checks the phase (column B) and adjusts the LBM:
     - If "Cut", LBM stays the same as the previous week.
     - If "Bulk", LBM increases by half of the weight gain (current week's weight - previous week's weight) / 2.
     - If "Maintenance", LBM remains unchanged.
   - Drag this formula down for all rows.

4. **Auto-Fill for Efficiency**:
   - Drag the corner of the cell containing the formula down the column to automatically apply it to all rows.

This setup will calculate your LBM based on the weight changes recorded in your sheet. Just ensure you regularly update the sheet with your current weight and phase for accurate tracking. Remember, these calculations are based on general assumptions and may not reflect the exact physiological changes in your body.

## Question

if minicut its the same formula as cut, and maintanence should be the same value as the previous week

## Answer

Understood. To adjust the formula for the Lean Body Mass (LBM) calculation in your Google Sheets to include the "Minicut" phase with the same logic as the "Cut" phase and to keep the LBM constant during the "Maintenance" phase, you can modify the formula as follows:

1. **Initial LBM**:
   - Enter your initial LBM value in the first row of the column designated for LBM calculated by scale (let's assume it's column H).

2. **Formula for LBM Calculation**:
   - Starting from the second row in your LBM column (e.g., H2), enter the following formula:
     \[ \text{=IF(OR(B2="Cut", B2="Minicut"), H1, IF(B2="Bulk", H1 + (E2 - E1) / 2, IF(B2="Maintenance", H1, "")))} \]
   - This formula works as follows:
     - If the phase is "Cut" or "Minicut", the LBM remains the same as the previous week.
     - If the phase is "Bulk", the LBM increases by half of the weight gain.
     - If the phase is "Maintenance", the LBM remains unchanged.

3. **Drag Down the Formula**:
   - Drag the corner of the cell containing this formula down through all the rows in your sheet.

This revised formula takes into account the specific conditions for each phase as per your instructions, ensuring that your LBM is calculated accurately based on the weight changes and the nature of the phase (Cut, Minicut, Bulk, or Maintenance).
