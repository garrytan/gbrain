---
title: "InnoDB Initialization Error"
type: note
created: 2023-05-25
updated: 2023-05-25
source: chatgpt-export
conversation_id: e2f6f968-c8e0-4a2f-81f9-8663e806b158
message_count: 2
tags: [chatgpt, import]
---
# InnoDB Initialization Error

**Related:** [[coding_troubleshoot]]

> Conversation ID: e2f6f968-c8e0-4a2f-81f9-8663e806b158
> Created: 2023-05-25T18:33:36Z
> Updated: 2023-05-25T18:33:59Z
> Messages: 2

---

## User

2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] InnoDB: Compressed tables use zlib 1.2.11
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] InnoDB: Number of transaction pools: 1
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] InnoDB: Using ARMv8 crc32 + pmull instructions
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] mariadbd: O_TMPFILE is not supported on /tmp (disabling future attempts)
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] InnoDB: Using liburing
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] InnoDB: Initializing buffer pool, total size = 128.000MiB, chunk size = 2.000MiB
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] InnoDB: Completed initialization of buffer pool
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [ERROR] InnoDB: MySQL-8.0 tablespace in ./ibdata1
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [ERROR] InnoDB: Restart in MySQL for migration/recovery.
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [ERROR] InnoDB: Plugin initialization aborted with error Unsupported
2023-05-25 11:33:11 2023-05-25 18:33:11 0 [Note] InnoDB: Starting shutdown...
2023-05-25 11:33:12 2023-05-25 18:33:12 0 [ERROR] Plugin 'InnoDB' init function returned error.
2023-05-25 11:33:12 2023-05-25 18:33:12 0 [ERROR] Plugin 'InnoDB' registration as a STORAGE ENGINE failed.
2023-05-25 11:33:12 2023-05-25 18:33:12 0 [Note] Plugin 'FEEDBACK' is disabled.
2023-05-25 11:33:12 2023-05-25 18:33:12 0 [ERROR] Could not open mysql.plugin table: "Table 'mysql.plugin' doesn't exist". Some plugins may be not loaded
2023-05-25 11:33:12 2023-05-25 18:33:12 0 [ERROR] Unknown/unsupported storage engine: InnoDB
2023-05-25 11:33:12 2023-05-25 18:33:12 0 [ERROR] Aborting

---

## Assistant

The log you provided appears to be from the MySQL server and contains information about its initialization and an error that occurred. Here's a breakdown of the important points in the log:

1. The log begins with various notes indicating the configuration and settings of the MySQL server. These include information about compressed tables, transaction pools, instructions used, and libraries being utilized.

2. There is an error stating that the O_TMPFILE feature is not supported on the `/tmp` directory, and future attempts to use it will be disabled. O_TMPFILE is a feature for creating temporary files, but it seems to be unsupported in this context.

3. The log shows the initialization of the InnoDB storage engine, which is the default storage engine in MySQL.

4. However, an error occurs related to the InnoDB tablespace stored in the `ibdata1` file. It indicates that there is a problem with the tablespace and suggests restarting the MySQL server for migration or recovery purposes.

5. The plugin initialization for InnoDB is aborted due to an error labeled as "Unsupported."

6. The MySQL server starts to shut down, presumably due to the encountered errors.

7. The InnoDB plugin fails to initialize and register as a storage engine, resulting in an error.

8. The 'FEEDBACK' plugin is disabled.

9. An error message appears stating that the `mysql.plugin` table doesn't exist, preventing the loading of certain plugins.

10. Finally, an error occurs indicating that the storage engine 'InnoDB' is unknown or unsupported, leading to the server's termination.

Based on this log, it seems that there is a problem with the InnoDB storage engine and its associated tablespace. Restarting the MySQL server might help with migration or recovery. Additionally, the absence of the `mysql.plugin` table and the unsupported storage engine contribute to the errors. Further investigation and troubleshooting are recommended to resolve the issue.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_al-error-troubleshooting]]
- [[chatgpt/chatgpt_api-key-domain-error]]
- [[chatgpt/chatgpt_artifact-download-error]]
- [[chatgpt/chatgpt_asset-loading-error-resolution-part1]]
- [[chatgpt/chatgpt_asset-loading-error-resolution-part2]]
