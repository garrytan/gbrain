---
title: "LBM Formula"
type: guide
created: 2024-01-14
updated: 2024-01-14
source: chatgpt-export
topic: misc
message_count: 11
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# LBM Formula

> **Source:** ChatGPT conversation
> **Date:** 2024-01-14T20:49:16Z
> **Messages:** 11
> **Topic:** misc

## Question

whats the formula for lean body mass

## Answer

The formula for lean body mass (LBM) is:

\[ \text{LBM} = \text{Total Body Weight} - \text{Body Fat Weight} \]

To calculate LBM, you first need to know your total body weight and your body fat percentage. Body fat weight is calculated as:

\[ \text{Body Fat Weight} = \text{Total Body Weight} \times \text{Body Fat Percentage} \]

Then, subtract the body fat weight from your total body weight to find your lean body mass.

## Question

Week	Phase		Date Start	Date End	Weight (LBs)	BF (Scale)	Fat Weight (LBs)	Rate	LBM (LBs)	FFMI	Height
0	Start				173.20	10.60%	18.36		154.84		
1	Cut	1	1/14/2024	1/21/2024	172.33	10.60%	18.27	-0.50%	154.07		1.93
2	Cut	2	1/21/2024	1/28/2024	171.47	10.15%	17.41	-0.50%	154.07		1.93
3	Cut	3	1/28/2024	2/4/2024	170.61	9.70%	16.55	-0.50%	154.07		1.93
4	Cut	4	2/4/2024	2/11/2024	169.76	9.25%	15.70	-0.50%	154.07		1.93
5	Cut	5	2/11/2024	2/18/2024	168.91	8.79%	14.85	-0.50%	154.07		1.93
6	Cut	6	2/18/2024	2/25/2024	168.07	8.33%	14.00	-0.50%	154.07		1.93
7	Maintainence	1	2/25/2024	3/3/2024	168.07	8.33%	14.00	0%	154.07		1.93
8	Maintainence	2	3/3/2024	3/10/2024	168.07	8.33%	14.00	0%	154.07		1.93
9	Maintainence	3	3/10/2024	3/17/2024	168.07	8.33%	14.00	0%	154.07		1.93
10	Maintainence	4	3/17/2024	3/24/2024	168.07	8.33%	14.00	0%	154.07		1.93
11	Maintainence	5	3/24/2024	3/31/2024	168.07	8.33%	14.00	0%	154.07		1.93
12	Maintainence	6	3/31/2024	4/7/2024	168.07	8.33%	14.00	0%	154.07		1.93
13	Bulk	1	4/7/2024	4/14/2

## Answer

To create a formula that reflects the changes in Lean Body Mass (LBM) based on your specific requirements, we need to take into account the rate of weight change and the nature of the phase (bulk/mass or cut/maintenance). Here's a proposed approach:

1. **Calculate Initial LBM**: For week 0, LBM is calculated using the standard formula: 
   \[ \text{LBM} = \text{Total Body Weight} - \text{Body Fat Weight} \]

2. **Update LBM for Subsequent Weeks**:
   - **During Bulk/Mass Phases**: Increase LBM by the same amount as the increase in total body weight (assuming a 1:1 ratio of muscle to fat gain).
   - **During Cut/Maintenance Phases**: LBM remains constant or decreases, reflecting only the loss of fat.

Here is the formula for subsequent weeks:

\[ \text{LBM}_{\text{new}} = \text{LBM}_{\text{previous}} + \Delta \text{Weight} \times \text{Muscle Gain Ratio} \]

- \(\Delta \text{Weight} = \text{Weight}_{\text{current week}} - \text{Weight}_{\text{previous week}}\)
- \(\text{Muscle Gain Ratio} = 1\) for Bulk/Mass phases, \(0\) for Cut/Maintenance phases (since muscle mass is either gained in a 1:1 ratio with fat or not gained at all).

This approach assumes that during cut and maintenance phases, any weight loss is purely from fat, and there is no muscle gain.

Let's calculate the LBM for each week based on this approach.

## Answer

Here's the calculated Lean Body Mass (LBM) for the first 10 weeks and the start of the bulk phase as an example:

- Week 0 (Start): LBM = 154.84 lbs
- Week 1 (Cut): LBM = 154.84 lbs
- Week 2 (Cut): LBM = 154.84 lbs
- Week 3 (Cut): LBM = 154.84 lbs
- Week 4 (Cut): LBM = 154.84 lbs
- Week 5 (Cut): LBM = 154.84 lbs
- Week 6 (Cut): LBM = 154.84 lbs
- Week 7 (Maintenance): LBM = 154.84 lbs
- Week 8 (Maintenance): LBM = 154.84 lbs
- Week 13 (Bulk): LBM = 155.68 lbs

The LBM remains constant during the cut and maintenance phases and increases during the bulk phase in line with the weight gain. This calculation follows the approach of 1:1 muscle to fat gain during the bulk phase and no muscle gain during cut/maintenance phases.

## Question

give me a google sheets formula


## Answer

To create a Google Sheets formula for calculating Lean Body Mass (LBM) that changes each week based on your specified criteria, you can use the following approach:

1. **Initial LBM Calculation (Week 0)**: In cell G2 (assuming Fat Weight is in F2 and Weight is in E2):
   ```
   =E2 - F2
   ```

2. **Subsequent Weeks LBM Calculation**:
   - In cell G3 (for Week 1) and drag down for all rows:
     ```
     =IF(OR(D3="Bulk", D3="Mass"), G2 + (E3 - E2), G2)
     ```
   This formula checks if the phase is "Bulk" or "Mass" (assuming the phase is in column D). If true, it adds the change in weight to the previous week's LBM. Otherwise, it keeps the LBM the same as the previous week.

Make sure to adjust the cell references according to your actual data layout in Google Sheets. This formula assumes:
- Column D contains the phase (e.g., "Bulk", "Cut", "Maintenance").
- Column E contains the Weight for each week.
- Column F contains the Fat Weight for each week.
- Column G will be where the LBM is calculated.

## Question

it actually f2-h2 for the initial one

## Answer

Understood. If you want to use the difference between cells F2 and H2 for the initial Lean Body Mass (LBM) calculation in Google Sheets, you can adjust the formula as follows:

1. **Initial LBM Calculation (Week 0)**: In cell I2 (assuming Fat Weight is in H2 and Weight is in F2):
   ```
   =F2 - H2
   ```

2. **Subsequent Weeks LBM Calculation**:
   - In cell I3 (for Week 1) and drag down for all rows:
     ```
     =IF(OR(D3="Bulk", D3="Mass"), I2 + (F3 - F2), I2)
     ```
   This formula checks if the phase is "Bulk" or "Mass" (assuming the phase is in column D). If true, it adds the change in weight to the previous week's LBM. Otherwise, it keeps the LBM the same as the previous week.

Here's how to interpret the formula:
- `F2 - H2` calculates the initial LBM.
- `IF(OR(D3="Bulk", D3="Mass"), I2 + (F3 - F2), I2)` checks the phase. If it's a bulk or mass phase, it calculates the new LBM by adding the weight change to the previous week's LBM. If it's not a bulk or mass phase, the LBM remains the same as the previous week.

Please ensure the column references (D, F, H, I) match the layout of your data in Google Sheets.

## Question

Columns in order are:
Total Weeks	Phase	Week #	Date Start	Date End	Weight (LBs)	BF (Scale)	Fat Weight (LBs)	Rate	LBM (LBs)	FFMI	Height

## Answer

Thank you for clarifying the column layout. Based on your column order, here's how you can set up the formula for Lean Body Mass (LBM) in Google Sheets:

1. **Initial LBM Calculation (Week 0)**: Place this formula in column J, starting from J2 (assuming Fat Weight is in H2 and Weight is in F2):
   ```
   =F2 - H2
   ```

2. **Subsequent Weeks LBM Calculation**:
   - In cell J3 (for Week 1) and drag down for all subsequent rows:
     ```
     =IF(OR(B3="Bulk", B3="Mass"), J2 + (F3 - F2), J2)
     ```
   This formula checks if the phase (in column B) is "Bulk" or "Mass". If true, it calculates the new LBM by adding the change in weight to the previous week's LBM. If the phase is not "Bulk" or "Mass" (e.g., "Cut" or "Maintenance"), the LBM remains the same as the previous week.

The columns are used as follows:
- Column B: Phase ("Bulk", "Mass", etc.)
- Column F: Weight for each week.
- Column H: Fat Weight for each week.
- Column J: LBM, where the calculation takes place.

Remember to drag the formula down in column J for all the weeks you have data for. This will automatically update the LBM each week based on the changes in weight and the specified phase.
