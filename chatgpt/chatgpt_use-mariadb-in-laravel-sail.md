---
title: "Use MariaDB in Laravel Sail"
type: guide
created: 2023-05-25
updated: 2023-05-25
source: chatgpt-export
conversation_id: 1d85b844-d6ad-4df3-95db-c5064f462ecb
message_count: 4
tags: [chatgpt, import, code]
---
# Use MariaDB in Laravel Sail

> Conversation ID: 1d85b844-d6ad-4df3-95db-c5064f462ecb
> Created: 2023-05-25T18:34:36Z
> Updated: 2023-05-25T18:35:45Z
> Messages: 4

---

## User

how to i use mariadb instead of mysql in laravel sail

---

## Assistant

To use MariaDB instead of MySQL in Laravel Sail, you need to make a few changes to your Sail configuration. Here's how you can do it:

1. Open your `docker-compose.yml` file located in the root of your Laravel project.

2. Find the `mysql` service definition and replace it with the following code:

```yaml
mysql:
    image: 'mariadb:latest'
    restart: unless-stopped
    volumes:
        - 'sailmysql:/var/lib/mysql'
    environment:
        MYSQL_ROOT_PASSWORD: '${DB_PASSWORD}'
        MYSQL_DATABASE: '${DB_DATABASE}'
        MYSQL_USER: '${DB_USERNAME}'
        MYSQL_PASSWORD: '${DB_PASSWORD}'
    networks:
        - sail
```

3. Replace the `mysql` keyword with `mariadb` to specify that you want to use MariaDB.

4. Save the `docker-compose.yml` file.

5. Open your `.env` file and update the `DB_CONNECTION` value to `mysql` if it's not already set.

6. In the same `.env` file, update the database configuration variables to match the values you provided in the `docker-compose.yml` file. For example:

```dotenv
DB_CONNECTION=mysql
DB_HOST=mysql
DB_PORT=3306
DB_DATABASE=your_database
DB_USERNAME=your_username
DB_PASSWORD=your_password
```

7. Save the `.env` file.

8. Finally, run the following command to rebuild your Sail containers with the new MariaDB configuration:

```
./vendor/bin/sail up -d --build
```

Now your Laravel Sail environment should be using MariaDB instead of MySQL. Make sure to update your application code and configuration accordingly if there are any specific differences or features you need to consider when using MariaDB instead of MySQL.

---

## User

its continuly restarting

---

## Assistant

If your Laravel Sail environment is continuously restarting after switching to MariaDB, it could be due to a configuration issue or a conflict with existing containers. Here are a few steps you can take to troubleshoot the problem:

1. Check for errors: Run the following command to view the logs and identify any errors or warnings that may be causing the restart loop:

   ```
   ./vendor/bin/sail logs
   ```

   Look for any error messages related to the MariaDB container or database configuration.

2. Remove existing containers: If there are conflicts with existing containers, you can try removing all containers associated with your Laravel Sail environment. Run the following command to stop and remove all containers:

   ```
   ./vendor/bin/sail down --volumes
   ```

   This command will also remove any associated volumes, so be cautious if you have important data stored in them.

3. Check system resources: Insufficient system resources such as memory or disk space can cause containers to restart. Make sure your system has enough resources available to run the containers.

4. Verify environment variables: Double-check that the environment variables in your `.env` file are correctly set for MariaDB, including the `DB_DATABASE`, `DB_USERNAME`, and `DB_PASSWORD`. Ensure that the values match the ones specified in the `docker-compose.yml` file.

5. Restart Docker: Try restarting Docker itself as it may resolve any underlying issues. You can restart Docker using the appropriate command for your operating system.

6. Rebuild containers: If all else fails, you can try rebuilding the Sail containers from scratch. Run the following commands:

   ```
   ./vendor/bin/sail down --volumes
   ./vendor/bin/sail up -d --build
   ```

   This will ensure a clean start by removing existing containers and rebuilding them.

If the problem persists after trying these steps, it might be helpful to provide the specific error messages or logs you encounter, as it can assist in diagnosing the issue further.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
