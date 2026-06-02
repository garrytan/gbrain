---
conversation_id: 68810b06-6490-8329-8795-643b2738701d
created: 2025-07-23
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Fastlane match GitHub token
type: note
updated: 2025-07-23
---

# Fastlane match GitHub token

**Related:** [[coding_mobile]]

> Conversation ID: 68810b06-6490-8329-8795-643b2738701d
> Created: 2025-07-23T16:17:11Z
> Updated: 2025-07-23T16:17:26Z
> Messages: 2

---

## User

fastlane match github token

---

## Assistant

​To configure Fastlane Match to authenticate with a private GitHub repository using a Personal Access Token (PAT), follow these steps:

---

### 1. Generate a GitHub Personal Access Token (PAT)

- Navigate to [GitHub's PAT settings](https://github.com/settings/tokens/new).
- Create a **classic** token with the following scopes:
  - `repo` (for private repository access)
  - `read:packages` (if needed)
- Copy the generated token securely.

---

### 2. Encode the Token in Base64

In your terminal, run:


```bash
echo -n 'your_github_username:your_personal_access_token' | base64
```


This will output a base64-encoded string.

---

### 3. Set the Environment Variable

Assign the encoded string to the `MATCH_GIT_BASIC_AUTHORIZATION` environment variable:


```bash
export MATCH_GIT_BASIC_AUTHORIZATION='base64_encoded_string'
```


Alternatively, you can set this variable in your CI/CD environment settings.

---

### 4. Configure Your Matchfile

In your `Matchfile`, specify the Git repository URL:


```ruby
git_url("https://github.com/your_org/your_cert_repo.git")
```


Ensure the repository is private and accessible using the PAT.

---

### 5. Run Fastlane Match

Execute Match with the desired type:


```bash
fastlane match appstore
# or
fastlane match development
```


Fastlane will use the `MATCH_GIT_BASIC_AUTHORIZATION` for authentication.

---

### Additional Notes

- For CI/CD environments, also set:
  - `MATCH_PASSWORD`: The passphrase used to encrypt/decrypt certificates.
  - `MATCH_USERNAME`: The Apple Developer account email.
- Avoid using SSH URLs (`git@github.com:...`) unless SSH keys are properly configured.
- The `GITHUB_TOKEN` provided by GitHub Actions may not suffice for accessing private repositories; using a PAT is recommended citeturn0search10.

For more detailed information, refer to the [Fastlane Match documentation](https://docs.fastlane.tools/actions/match/). 
