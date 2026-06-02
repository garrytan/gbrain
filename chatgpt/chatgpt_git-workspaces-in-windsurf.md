---
title: "Git workspaces in WindSurf"
type: note
created: 2025-12-02
updated: 2025-12-03
source: chatgpt-export
conversation_id: 692f73fe-6680-8325-af4f-091682f3bc07
message_count: 2
tags: [chatgpt, import, code]
---
# Git workspaces in WindSurf

> Conversation ID: 692f73fe-6680-8325-af4f-091682f3bc07
> Created: 2025-12-02T23:19:27Z
> Updated: 2025-12-03T00:42:08Z
> Messages: 2

---

## User

how to use git workspaces with multiple cascade instacnes in windsurf

---

## Assistant

Here’s a clear, concise guide for using **Git Workspaces** with **multiple Cascade instances** inside **Windsurf** (the new JetBrains-based IDE).

---

## ✅ What “Git Workspaces” Means in Windsurf
Windsurf supports **multi-root Git workspaces**, meaning you can have several repos and branches open simultaneously in the same project window. This is useful when running multiple **Cascade** microservice instances, each needing its own checkout and branch.

---

## 📌 Setup: Multiple Cascade Instances With Git Workspaces

### **1. Create a Parent “Workspace” Folder**
Example:
```
/cascade-workspace/
   /instance-1/
   /instance-2/
   /instance-3/
```

Each `instance-*` is its own Git repo (clone of Cascade).

### **2. Add Each Instance as a Workspace Folder**
In Windsurf:

**File → Add Folder to Workspace… → Select instance-1**  
Repeat for instance-2, instance-3, etc.

Windsurf now treats all of them as separate Git roots but part of one workspace.

---

## 📌 Using Git With Multiple Instances

### **3. Check Git Roots**
Windsurf automatically detects multiple repos:

**View → Tool Windows → Git**  
You’ll see:
```
instance-1 (git)
instance-2 (git)
instance-3 (git)
```

### **4. Switch Branches Per Instance**
In the bottom-right Git panel, switch branches for each repo independently.

Example:
- instance-1 → feature/add-logging  
- instance-2 → develop  
- instance-3 → hotfix/override-auth  

### **5. Independent Changes, Commits, and Pushes**
Each repo has its own changelist:

**Git → Commit…**  
You’ll see:
```
Changes (instance-1)
Changes (instance-2)
Changes (instance-3)
```

Windsurf prevents cross-root commits by default.

---

## 📌 Running Multiple Cascade Instances

### **6. Create Separate Run Configurations**
For each instance:

**Run → Edit Configurations → Add New → Node / Docker / whatever Cascade uses**

Typical example:
```
Instance 1 – PORT=7101
Instance 2 – PORT=7102
Instance 3 – PORT=7103
```

Point each config’s working directory to its respective instance folder.

### **7. Launch All Instances in Parallel**
Use the **Run tool window** → Start each configuration.

Windsurf isolates environment vars and working directories per configuration, so each runs independently.

---

## 📌 Optional: Workspace Automation

### **8. .windsurfrc / Workspace Settings**
You can create a `.windsurf-workspace` or use the built-in workspace settings to:

- Auto-load each Cascade instance
- Auto-attach terminals per instance
- Auto-run start scripts per root

---

## 📌 Quick Summary for Mr. White
- Use a **parent folder** containing multiple Cascade clones.  
- Add each clone to Windsurf via **Add Folder to Workspace**.  
- Each folder becomes a **separate Git root** with independent branches.  
- Create separate **Run Configurations** for each instance.  
- Start all instances simultaneously.

---

If you want, I can generate:
- A step-by-step with screenshots  
- A ready-made Windsurf workspace template  
- Recommended folder structure for 5–10 Cascade instances  

Just tell me what you’d prefer, Mr. White.
