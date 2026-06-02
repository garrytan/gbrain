---
title: "SonarCloud CLI Guide"
type: note
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
conversation_id: 69538dd0-153c-832b-b81c-2d6d2a21c686
message_count: 2
tags: [chatgpt, import, code]
---
# SonarCloud CLI Guide

> Conversation ID: 69538dd0-153c-832b-b81c-2d6d2a21c686
> Created: 2025-12-30T08:31:13Z
> Updated: 2025-12-30T08:32:01Z
> Messages: 2

---

## User

sonarclousre cli

---

## Assistant

**SonarCloud CLI (actually SonarScanner CLI) — quick concise guide**

SonarCloud doesn’t have a unique “SonarCloud-only CLI” tool per se — you use the standard **SonarScanner CLI** to run code analysis from the command line against SonarCloud projects. citeturn0search0turn0search2

---

## 1) What it is

The **SonarScanner CLI** is the official command-line tool that sends your project’s source code to SonarCloud (or SonarQube) for static analysis. citeturn0search0

---

## 2) Install

**Steps:**
1. Download the **SonarScanner CLI** distribution for your OS from the official site or GitHub releases. citeturn0search15  
2. Extract it locally.  
3. Add the `bin/` directory (or `…\bin` on Windows) to your shell PATH.  
4. Verify installation:

```bash
sonar-scanner -h
```
You should see usage help. citeturn0search0

---

## 3) Setup for SonarCloud projects

Create a file named `sonar-project.properties` in the **root of your project** with at minimum:

```
sonar.projectKey=YOUR_SONARCLOUD_PROJECT_KEY
sonar.organization=YOUR_SONARCLOUD_ORG
sonar.host.url=https://sonarcloud.io
sonar.sources=.
```

You can also supply these properties on the CLI instead of the config file. citeturn0search0

**Authentication:** set a token (generated in your SonarCloud account) as an environment variable:

```bash
export SONAR_TOKEN="your_sonarcloud_token"
```

Or pass it on the command line:

```bash
sonar-scanner -Dsonar.token="your_sonarcloud_token"
```

---

## 4) Run analysis

From your project root:

```bash
sonar-scanner
```

This will upload your code analysis to SonarCloud. citeturn0search0

If you need more verbosity for troubleshooting:

```bash
sonar-scanner -X
```
or

```bash
-Dsonar.verbose=true
```

---

## 5) Alternative / CI usage

You can run the SonarScanner CLI in a **Docker container** instead of installing it locally:

```bash
docker run --rm \
  -e SONAR_HOST_URL="https://sonarcloud.io" \
  -e SONAR_TOKEN="$SONAR_TOKEN" \
  -e SONAR_SCANNER_OPTS="-Dsonar.projectKey=YOUR_KEY" \
  -v "$PWD:/usr/src" sonarsource/sonar-scanner-cli
```
(Replace environment values appropriately.) citeturn0search20

---

## 6) Notes

- The Scanner requires **Java** installed locally unless you use the Docker image. citeturn0search0
- For specific languages (e.g., .NET), there are language-specific scanner variants like `dotnet-sonarscanner`. citeturn0search28

---

If you want a **ready-to-use sample config or CI pipeline snippet** (e.g., GitHub Actions) for SonarCloud CLI integration, just let me know.


## See Also
- [[chatgpt/chatgpt_7-eleven-rewards-guide]]
- [[chatgpt/chatgpt_angel-round-research-guide]]
- [[chatgpt/chatgpt_apple-music-style-guide-part1]]
- [[chatgpt/chatgpt_apple-music-style-guide-part2]]
- [[chatgpt/chatgpt_apple-music-style-guide-part3]]
