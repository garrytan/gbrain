---
title: "Large file exceeds limit."
type: guide
created: 2023-02-23
updated: 2023-02-23
source: chatgpt-export
topic: coding-general
message_count: 8
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# Large file exceeds limit.

> **Source:** ChatGPT conversation
> **Date:** 2023-02-23T06:09:23Z
> **Messages:** 8
> **Topic:** coding-general

## Question


Writing objects: 100% (48/48), 145.72 MiB | 1.63 MiB/s, done.
Total 48 (delta 24), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (24/24), completed with 9 local objects.
remote: error: Trace: be7ce5f7e3896b43f5eb744805dddc1ce68b116f3a997ff36d4d5f1b50f43732
remote: error: See http://git.io/iEPt8g for more information.
remote: error: File src/assets/videos/Reel 22_3840x2160_prob-3_1.mp4 is 145.74 MB; this exceeds GitHub's file size limit of 100.00 MB
remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.
To https://github.com/itstimwhite/wings.git
 ! [remote rejected] main -> main (pre-receive hook declined)
error: failed to push some refs to 'https://github.com/itstimwhite/wings.git'
Enumerating objects: 64, done.
Counting objects: 100% (64/64), done.
Delta compression using up to 16 threads
Writing objects: 100% (48/48), 145.72 MiB | 1.51 MiB/s, done.
Total 48 (delta 24), reused 0 (delta 0), pack-reused 0

## Answer

This error message indicates that you are trying to push a file to a GitHub repository that exceeds GitHub's file size limit of 100 MB. Specifically, the file `src/assets/videos/Reel 22_3840x2160_prob-3_1.mp4` is 145.74 MB in size. 

To resolve this issue, you can try using Git Large File Storage (LFS) to manage large files in your repository. Git LFS is an extension for Git that allows you to store large files outside of your Git repository while still keeping track of their changes. You can find more information about Git LFS at https://git-lfs.github.com/.

Alternatively, you can consider compressing the file or using a cloud storage service like Dropbox or Google Drive to share the file instead of including it in your repository.

## Question

im trying to use git-lfs but it doesnt seem to be working

## Answer

If you are having trouble using Git LFS, there are a few things you can try:

1. Make sure you have installed Git LFS on your system. You can download and install Git LFS from https://git-lfs.github.com/.

2. After installing Git LFS, run `git lfs install` in your repository to set up Git LFS.

3. Use the `git lfs track` command to tell Git LFS which files you want to track. For example, if you want to track all `.mp4` files in your repository, you can run `git lfs track "*.mp4"`.

4. Add the tracked files to your Git repository and commit the changes.

5. Push the changes to the remote repository. Make sure the remote repository is set up to use Git LFS as well.

If you are still having trouble, you can try checking the Git LFS logs for any error messages by running `git lfs logs last`. This command will show the logs for the last Git LFS operation.

You can also try searching the Git LFS documentation or community forums for more information on troubleshooting Git LFS issues.

## Question


Writing objects: 100% (56/56), 145.72 MiB | 1.66 MiB/s, done.
Total 56 (delta 29), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (29/29), completed with 9 local objects.
remote: error: Trace: e537fab901ddbbe944e41896398c1224cdfac67b8526a7284871bc0cba765c6f
remote: error: See http://git.io/iEPt8g for more information.
remote: error: File src/assets/videos/Reel 22_3840x2160_prob-3_1.mp4 is 145.74 MB; this exceeds GitHub's file size limit of 100.00 MB
remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.
To https://github.com/itstimwhite/wings.git
 ! [remote rejected] main -> main (pre-receive hook declined)
error: failed to push some refs to 'https://github.com/itstimwhite/wings.git'
PS C:\Users\Tim White\Documents\GitHub\wings_site> git lfs logs last

## Answer

From the error message you posted, it looks like you are still having trouble pushing your Git repository to GitHub due to a large file size limit.

Based on the error message, the file `src/assets/videos/Reel 22_3840x2160_prob-3_1.mp4` is exceeding GitHub's file size limit of 100.00 MB. To fix this, you can try using Git LFS (Large File Storage) to manage large files in your Git repository.

Here are the general steps to use Git LFS in your Git repository:

1. Install Git LFS on your local machine by following the instructions at https://git-lfs.github.com/.
2. Initialize Git LFS in your repository by running `git lfs install` in the root of your Git repository.
3. Add the file types that you want to track with Git LFS by running `git lfs track "*.mp4"` (replace `.mp4` with the file type of the large file you are trying to push).
4. Add and commit the changes to your repository as usual.
5. Push the changes to GitHub. The large file(s) should now be managed by Git LFS.

If you have already installed Git LFS and followed the steps above but are still having trouble pushing your changes to GitHub, you can try running `git lfs logs last` to see if there are any error messages that might help diagnose the issue. You can also check out the Git LFS documentation for more information on troubleshooting common issues.

## Question

ive completed these steps and still getting the same

## Answer

If you have completed the steps I outlined earlier and you are still experiencing issues, there are a few additional steps you can try:

1. Ensure that you have properly configured Git LFS on your local machine. You can do this by running `git lfs env` in your repository to check if Git LFS is properly installed and configured.
2. Check that the large file you are trying to push is actually being tracked by Git LFS. You can do this by running `git lfs ls-files` to see a list of files that are being tracked by Git LFS.
3. Try removing the large file from your repository history by using Git's `filter-branch` command. This will rewrite the history of your repository, removing the large file from all previous commits. However, be aware that this can be a destructive operation and should be used with caution. You can find more information on how to use `filter-branch` to remove large files in the Git LFS documentation.
4. If none of the above steps work, you can try uploading the large file to a separate file hosting service (such as Amazon S3 or Google Drive) and including a link to the file in your repository instead of pushing the file directly to GitHub.

If you continue to experience issues, it may be helpful to reach out to the Git LFS community or GitHub support for additional assistance.
