## 1. Configuration

*(Optional section for the report, omit if no relevant findings are present.)*

- **AGP Version**: \[Current\] -\> Upgrade to 9.0.
- **Full Mode** : Not enabled. Remove `android.enableR8.fullMode=false` from `gradle.properties`.

## 2. Global disable rules

*(Optional section for the report, omit if no relevant findings are present.)*

- \[Rule\]: Disables R8 globally. **Action**: Remove.

If there is -dontobfuscate, -dontoptimize or -dontshrink in the codebase,
mention in this section

## 3. Optimization summary

- **Optimization score**: \[X\]% code is available for R8 optimizations (e.g., inlining, merging). \[100-X\]% of codebase can't be optimized by R8.
- **Shrinking score**: \[X\]% of code will be optimized by R8 by removing unused classes, fields and methods. \[100-X\]% of codebase contains redundant classes, fields and methods that can't be removed by R8.
- **Obfuscation score**: \[X\]% of the codebase is available for R8 to obfuscate.

Increasing these scores increases the codebase available to R8 for
optimizations.

## 4. Keep rules evaluation

### \[Rule text\]

- **Keeps**: \[X\] items or \[X\] % of the codebase from optimization. Classes: \[X\], Fields: \[X\], Methods: \[X\] are prevented from optimization due to this keep rule
- **Kept items**: \[Class1\], \[Class2\]
- **Action** : **Remove** (Library bundles rules) OR **Refine** (Too broad, use \[Surgical Rule\]).

## 5. Subsumed keep rules

*(Optional section for the report, omit if no relevant findings are present.)*

### \[Redundant rules\]

- **Subsumed By**: \[Broader Rule\]
- **Action** : **Remove**.

## 6. Historical analysis summary

*(Only include this section if a previous report existed. Summarize the changes
in optimization scores here to track progress. For example:)* The previous app
had scores: Optimization (XX%), Obfuscation (XX%), and Shrinking (XX%). The
current app has scores: Optimization (YY%), Obfuscation (YY%), and Shrinking
(YY%).
**Change**: Optimization improved by ZZ%, Obfuscation improved by ZZ%, and
Shrinking improved by ZZ%.