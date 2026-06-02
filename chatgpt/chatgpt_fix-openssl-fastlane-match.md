---
conversation_id: 69235a04-02e8-832e-a0df-1e195254ba69
created: 2025-11-23
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Fix OpenSSL Fastlane Match
type: note
updated: 2025-11-23
---

# Fix OpenSSL Fastlane Match

**Related:** [[coding_mobile]]

> Conversation ID: 69235a04-02e8-832e-a0df-1e195254ba69
> Created: 2025-11-23T19:01:29Z
> Updated: 2025-11-23T19:01:44Z
> Messages: 2

---

## User

fix open ssl in fastlane match

---

## Assistant

Mr. White — this happens because newer macOS versions ship with LibreSSL or an OpenSSL version incompatible with Fastlane Match when using older encrypted repo formats.

**Typical errors include:**
```
OpenSSL::Cipher::CipherError
unsupported encryption algorithm
```
or
```
OpenSSL version mismatch
```

---

### **Fix Steps (Most Reliable)**

#### **1. Install a compatible OpenSSL**
Run:

```sh
brew install openssl@3
brew link --force openssl@3
```

Check version:

```sh
openssl version
```

You want **OpenSSL 3.x**, not LibreSSL.

---

#### **2. Force Ruby to use Homebrew OpenSSL**
If you're using system Ruby, add:

```sh
export LDFLAGS="-L/usr/local/opt/openssl@3/lib"
export CPPFLAGS="-I/usr/local/opt/openssl@3/include"
export PKG_CONFIG_PATH="/usr/local/opt/openssl@3/lib/pkgconfig"
```

(If using Apple Silicon, paths may be `/opt/homebrew/...` instead.)

---

#### **3. Reinstall `openssl`-dependent gems**
```sh
gem uninstall openssl
gem install openssl -- --use-system-libraries
```

Then reinstall fastlane:

```sh
gem uninstall fastlane
gem install fastlane
```

---

### **4. If Using Bundler**
Update your `Gemfile`:

```ruby
gem "openssl", "~> 3.0"
```

Then:

```sh
bundle update openssl fastlane
bundle install
```

---

### **5. Recreate Certificates (Optional)**
If your repo was encrypted under an older cipher:

```sh
fastlane match nuke development
fastlane match development
```

This forces Match to re-encrypt using the current OpenSSL engine.

---

### **Quick Known-Working Environment**
- Ruby: **3.1 – 3.3**
- OpenSSL: **3.x**
- Fastlane: **>= 2.220.0**

---

### If This Still Fails
Tell me your:

```
ruby -v
fastlane -v
openssl version
```

and whether you're using:

- Bundler  
- rbenv / rvm / asdf  
- System Ruby  

I’ll give exact commands based on your setup.

---

Would you like the patch optimized for `rbenv`, `asdf`, or system Ruby?


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
