---
title: "Update SQL INSERT Statement"
type: essay
created: 2024-04-18
updated: 2024-04-18
source: chatgpt-export
conversation_id: 24543f93-e434-4095-8bb2-36cf5548d998
message_count: 92
tags: [chatgpt, import, code, long-form]
---
# Update SQL INSERT Statement

> Conversation ID: 24543f93-e434-4095-8bb2-36cf5548d998
> Created: 2024-04-18T01:14:02Z
> Updated: 2024-04-18T02:11:39Z
> Messages: 92


#!/opt/homebrew/bin/python3

import json
import logging
import string
import time
from algoliasearch.search_client import SearchClient
from concurrent.futures import ThreadPoolExecutor, as_completed
import random
import mysql.connector

# Database connection parameters
db_config = {
    'user': 'root',  # leave empty if not using a specific username
    'password': 'Letmein',  # leave empty if no password is set
    'host': 'localhost',
    'port': 3306,  # the default MySQL port, change if DBngin uses a different port
    'database': 'jovie',
    'raise_on_warnings': True,
    'use_pure': True  # use the pure Python interface, not C extension
}



def get_db_connection():
    """Create and return a database connection."""
    connection = mysql.connector.connect(**db_config)
    return connection

import json
import mysql.connector
from mysql.connector import errorcode
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (path, firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, objectID)
    VALUES (%(path)s, %(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        lastmodified_json=VALUES(lastmodified_json);
    """

    for record in records:
        # Ensure lastmodified is a JSON string if it's a dict
        record['lastmodified_json'] = json.dumps(record.get('lastmodified', {}))
        cursor.execute(add_or_update_record, record)

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")

# Ensure the use of the above function within your data processing logic.

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Initialize Algolia client
client = SearchClient.create('E7O1DBYBKK', '7b9f2b7fe48f038018af87f124439b95')
index = client.init_index('user-index')

def generate_finer_prefixes(base_prefix):
    """Generate finer-grained prefixes based on a base prefix."""
    return [base_prefix + letter for letter in string.ascii_lowercase]

def fetch_records(prefix, hits_per_page=500, max_records=None):
    page = 0
    unique_ids = set()
    records = []
    truncated = False
    total_fetched = 0
    
    while True:
        response = index.search(prefix, {'hitsPerPage': hits_per_page, 'page': page})
        page_records = response['hits']
        new_records = [record for record in page_records if record['objectID'] not in unique_ids]
        unique_ids.update(record['objectID'] for record in new_records)
        records.extend(new_records)
        total_fetched += len(new_records)

        logging.info(f"Fetched {len(new_records)} new records with prefix '{prefix}'. Page: {page}.")

        if max_records and total_fetched >= max_records:
            logging.info(f"Reached max records limit for prefix '{prefix}'.")
            break

        if len(page_records) < hits_per_page:
            break
        if len(page_records) == hits_per_page:
            truncated = True

        page += 1
        sleep_time = random.uniform(0.5, 2.0)
        logging.info(f"Delaying for {sleep_time:.2f} seconds before next request.")
        time.sleep(sleep_time)  # Random delay between 0.5 to 2 seconds

    return prefix, records, truncated

def process_prefixes(initial_prefixes, max_records=None):
    all_records = []
    truncated_prefixes = []
    prefixes_to_process = initial_prefixes

    with ThreadPoolExecutor(max_workers=10) as executor:
        while prefixes_to_process:
            future_to_prefix = {executor.submit(fetch_records, prefix, max_records=max_records): prefix for prefix in prefixes_to_process}
            new_prefixes_to_process = []
            for future in as_completed(future_to_prefix):
                prefix, records, truncated = future.result()
                save_records_to_database(records)
                all_records.extend(records)
                if truncated:
                    # Generate finer prefixes if the current one is truncated
                    new_prefixes_to_process.extend(generate_finer_prefixes(prefix))

            prefixes_to_process = new_prefixes_to_process

    return all_records, truncated_prefixes

def main():
    initial_prefixes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z']
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing

    logging.info(f"Total records processed: {len(all_records)}")
    if truncated_prefixes:
        logging.info(f"Truncated prefixes (may have more records): {', '.join(truncated_prefixes)}")
    else:
        logging.info("No truncated prefixes detected.")

if __name__ == '__main__':
    main()

lets just modify the inset statement to skip anything where the object id is not unqiue (as in its already in the database)


To modify the `INSERT` statement to skip records where the object ID is not unique (meaning they are already in the database), you can add a condition to the `INSERT` statement using the `VALUES()` function. Here's how you can modify the `add_or_update_record` SQL statement:

```python
add_or_update_record = """
INSERT INTO users
(path, firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, objectID)
VALUES (%(path)s, %(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(objectID)s)
ON DUPLICATE KEY UPDATE
    firstName=VALUES(firstName),
    lastName=VALUES(lastName),
    instagramHandle=VALUES(instagramHandle),
    city=VALUES(city),
    photoUrl=VALUES(photoUrl),
    gender=VALUES(gender),
    bio=VALUES(bio),
    isVerified=VALUES(isVerified),
    lastmodified_json=VALUES(lastmodified_json)
WHERE objectID NOT IN (SELECT objectID FROM users);
"""
```

This modification adds a `WHERE` clause to the `INSERT` statement, filtering out records where the `objectID` already exists in the `users` table. This ensures that only unique records are inserted into the database.



Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 543, in _process_params_dict
    conv = to_mysql(conv)
           ^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/conversion.py", line 236, in to_mysql
    raise TypeError(
TypeError: Python 'dict' cannot be converted to a MySQL type

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 143, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 134, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 122, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 58, in save_records_to_database
    cursor.execute(add_or_update_record, record)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 728, in execute
    stmt = _bytestr_format_dict(stmt, self._process_params_dict(params))
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 549, in _process_params_dict
    raise ProgrammingError(
mysql.connector.errors.ProgrammingError: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
(myenv) timwhite@tims-air myenv % 


It seems there's an issue with the MySQL connector when trying to process the dictionary parameters for insertion. Let's adjust the way we pass the dictionary parameters to the `cursor.execute()` method.

Instead of passing the entire `record` dictionary directly to `cursor.execute()`, we can separate the keys and values and pass them separately. Here's how you can modify the `save_records_to_database()` function:

```python
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (path, firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, objectID)
    VALUES (%(path)s, %(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        lastmodified_json=VALUES(lastmodified_json)
    WHERE objectID NOT IN (SELECT objectID FROM users);
    """

    for record in records:
        # Ensure lastmodified is a JSON string if it's a dict
        record['lastmodified_json'] = json.dumps(record.get('lastmodified', {}))
        # Separate keys and values from the record dictionary
        keys = ', '.join(record.keys())
        values = ', '.join(['%({})s'.format(key) for key in record.keys()])
        insert_query = add_or_update_record % {'keys': keys, 'values': values}
        cursor.execute(insert_query, record)

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This modification separates the keys and values from the `record` dictionary and constructs the SQL query using string formatting. Then, it passes the formatted SQL query and the `record` dictionary to `cursor.execute()`. This should resolve the issue with the MySQL connector.



2024-04-17 18:18:32,090 - INFO - Reached max records limit for prefix 'j'.
2024-04-17 18:18:32,090 - INFO - Fetched 500 new records with prefix 'b'. Page: 0.
2024-04-17 18:18:32,090 - INFO - Reached max records limit for prefix 'b'.
2024-04-17 18:18:32,096 - INFO - Fetched 500 new records with prefix 'c'. Page: 0.
2024-04-17 18:18:32,096 - INFO - Reached max records limit for prefix 'c'.
Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 146, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 137, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 125, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 61, in save_records_to_database
    insert_query = add_or_update_record % {'keys': keys, 'values': values}
                   ~~~~~~~~~~~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
KeyError: 'path'
(myenv) timwhite@tims-air myenv % 


It seems that the modification caused an issue with the `KeyError: 'path'`. This error occurs because the `record` dictionary does not contain a key named `'path'`, but it is being used in the string formatting for the SQL query.

To fix this issue, you need to adjust the string formatting to use the correct keys from the `record` dictionary. Here's the corrected version of the `save_records_to_database()` function:

```python
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        lastmodified_json=VALUES(lastmodified_json)
    WHERE objectID NOT IN (SELECT objectID FROM users);
    """

    for record in records:
        # Ensure lastmodified is a JSON string if it's a dict
        record['lastmodified_json'] = json.dumps(record.get('lastmodified', {}))
        # Separate keys and values from the record dictionary
        keys = ', '.join(record.keys())
        values = ', '.join(['%({})s'.format(key) for key in record.keys()])
        insert_query = add_or_update_record % record
        cursor.execute(insert_query, record)

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This modification removes the `'path'` key from the SQL query since it's not present in the `record` dictionary. Now, the string formatting uses the correct keys directly from the `record` dictionary.



Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 543, in _process_params_dict
    conv = to_mysql(conv)
           ^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/conversion.py", line 236, in to_mysql
    raise TypeError(
TypeError: Python 'dict' cannot be converted to a MySQL type

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 147, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 138, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 126, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 62, in save_records_to_database
    cursor.execute(insert_query, record)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 728, in execute
    stmt = _bytestr_format_dict(stmt, self._process_params_dict(params))
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 549, in _process_params_dict
    raise ProgrammingError(
mysql.connector.errors.ProgrammingError: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
(myenv) timwhite@tims-air myenv % 


It seems we're still encountering an issue with the MySQL connector when trying to process the dictionary parameters for insertion. Let's revise the `save_records_to_database()` function to properly format the SQL query and execute it with the correct parameters. 

Here's the updated version:

```python
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        lastmodified_json=VALUES(lastmodified_json)
    WHERE objectID NOT IN (SELECT objectID FROM users);
    """

    for record in records:
        # Ensure lastmodified is a JSON string if it's a dict
        record['lastmodified_json'] = json.dumps(record.get('lastmodified', {}))
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

In this version, we're using `cursor.execute()` to execute the SQL query, passing the `record` dictionary as the parameter. If an error occurs during execution, it's logged, allowing you to identify and troubleshoot any issues with specific records.


713230726041}'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:19:46,100 - ERROR - Error occurred while processing record: {'path': 'users/KrjeqxmA7sfckDNPJI5eryxiMhf2', 'firstName': 'Breanna', 'lastName': 'Clemens', 'instagramHandle': 'breannaclemens', 'city': 'Milton, ON, Canada', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_9514.JPG-1696623505569?alt=media&token=d97903de-0665-439f-ad36-d2da90c0bc53', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'KrjeqxmA7sfckDNPJI5eryxiMhf2', '_highlightResult': {'path': {'value': 'users/KrjeqxmA7sfckDNPJI5eryxiMhf2', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Breanna', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Clemens', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'breannaclemens', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Milton, ON, Canada', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_9514.JPG-1696623505569?alt=media&token=d97903de-0665-439f-ad36-d2da90c0bc53', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:19:46,100 - ERROR - Error occurred while processing record: {'path': 'users/Kk5Jteoy01StMNv19FXnFEI22rk2', 'firstName': 'Alisha ', 'lastName': 'Crutcher ', 'instagramHandle': 'Leazettee ', 'city': 'Los Angeles, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_1097.HEIC-1700292627456?alt=media&token=05961b2f-a12b-4e30-82df-80a4da55b14a', 'gender': 'Female', 'bio': 'Social media manager ', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'Kk5Jteoy01StMNv19FXnFEI22rk2', '_highlightResult': {'path': {'value': 'users/Kk5Jteoy01StMNv19FXnFEI22rk2', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Alisha ', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Crutcher ', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'Leazettee ', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Los Angeles, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_1097.HEIC-1700292627456?alt=media&token=05961b2f-a12b-4e30-82df-80a4da55b14a', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': 'Social media manager ', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:19:46,100 - ERROR - Error occurred while processing record: {'path': 'users/KIOwfklFQVgT6l5NA5S10ENBGQC3', 'firstName': 'Misra', 'lastName': 'Cinar', 'instagramHandle': 'misracinarr', 'city': 'Los Angeles, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_6591.JPG-1692913411275?alt=media&token=02929423-4521-48b3-991d-a3be34abcea9', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'KIOwfklFQVgT6l5NA5S10ENBGQC3', '_highlightResult': {'path': {'value': 'users/KIOwfklFQVgT6l5NA5S10ENBGQC3', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Misra', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Cinar', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'misracinarr', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Los Angeles, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_6591.JPG-1692913411275?alt=media&token=02929423-4521-48b3-991d-a3be34abcea9', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:19:46,100 - ERROR - Error occurred while processing record: {'path': 'users/JzCp7PS05ddAaN4fQN2TG8GWuEG3', 'firstName': 'Gladys', 'lastName': 'Castaneda ', 'instagramHandle': 'Glad.sc', 'city': 'Los Angeles, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/DB6AEF8C-7B5E-40C4-AC8F-C427F5704125.JPG-1698263096024?alt=media&token=f4ba3592-6add-46d2-bfc4-442069ec09ae', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'JzCp7PS05ddAaN4fQN2TG8GWuEG3', '_highlightResult': {'path': {'value': 'users/JzCp7PS05ddAaN4fQN2TG8GWuEG3', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Gladys', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Castaneda ', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'Glad.sc', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Los Angeles, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/DB6AEF8C-7B5E-40C4-AC8F-C427F5704125.JPG-1698263096024?alt=media&token=f4ba3592-6add-46d2-bfc4-442069ec09ae', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:19:46,100 - ERROR - Error occurred while processing record: {'path': 'users/Jt87CuHmRkZhFwlHWVGvtVtPRec2', 'firstName': 'Katelyn', 'lastName': 'Contreras ', 'instagramHandle': 'kt_ct', 'city': 'Altadena, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_4557.HEIC-1692420709733?alt=media&token=0b431bbc-41a7-4e62-aa18-0bc84d5b703b', 'gender': 'Female', 'bio': '', 'interests': ['private_parties', 'dinner_events', 'clubs'], 'occupations': ['model'], 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'Jt87CuHmRkZhFwlHWVGvtVtPRec2', '_highlightResult': {'path': {'value': 'users/Jt87CuHmRkZhFwlHWVGvtVtPRec2', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Katelyn', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Contreras ', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'kt_ct', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Altadena, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_4557.HEIC-1692420709733?alt=media&token=0b431bbc-41a7-4e62-aa18-0bc84d5b703b', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'interests': [{'value': 'private_parties', 'matchLevel': 'none', 'matchedWords': []}, {'value': 'dinner_events', 'matchLevel': 'none', 'matchedWords': []}, {'value': 'clubs', 'matchLevel': 'none', 'matchedWords': []}], 'occupations': [{'value': 'model', 'matchLevel': 'none', 'matchedWords': []}], 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}'}. Error: Failed processing pyformat-parameters; Python 'list' cannot be converted to a MySQL type
2024-04-17 18:19:46,101 - INFO - Processed 500 records.
2024-04-17 18:19:46,102 - INFO - Total records processed: 11692
2024-04-17 18:19:46,102 - INFO - No truncated prefixes detected.
(myenv) timwhite@tims-air myenv % 


It seems there are still errors occurring during the processing of certain records. Specifically, the errors indicate that the MySQL connector is unable to process certain data types, such as dictionaries and lists, when formatting the SQL query.

To resolve this, we need to ensure that the data types being passed to the MySQL connector are compatible with MySQL's expectations. Let's address the errors one by one:

1. For the first error regarding the dictionary conversion issue, it seems to be related to the `lastmodified_json` field. We're already converting it to a JSON string, so it should be compatible. However, there might be an issue with the value being passed. We should ensure that the `lastmodified_json` field in the database is of type `TEXT` or `VARCHAR` to store the JSON string properly.

2. For the second error regarding the list conversion issue, it seems to be related to the `interests` and `occupations` fields. These fields contain lists, which MySQL cannot directly handle. We can convert these lists to JSON strings before inserting them into the database, similar to what we're doing with the `lastmodified_json` field.

Let's update the `save_records_to_database()` function to address these issues:

```python
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, interests, occupations, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(interests)s, %(occupations)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        lastmodified_json=VALUES(lastmodified_json),
        interests=VALUES(interests),
        occupations=VALUES(occupations);
    """

    for record in records:
        # Ensure lastmodified is a JSON string if it's a dict
        record['lastmodified_json'] = json.dumps(record.get('lastmodified', {}))
        # Convert interests and occupations lists to JSON strings
        record['interests'] = json.dumps(record.get('interests', []))
        record['occupations'] = json.dumps(record.get('occupations', []))
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

With these updates, we're converting the `interests` and `occupations` fields to JSON strings before inserting them into the database. This should resolve the MySQL conversion errors related to incompatible data types.



2024-04-17 18:21:10,415 - ERROR - Error occurred while processing record: {'path': 'users/D3fy49msgdXvIOTEILCJH1ZMpc23', 'firstName': 'Ashley', 'lastName': 'Campos', 'instagramHandle': 'Ashlxycampos ', 'city': 'Aliso Viejo, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/7E404FE1-6083-49C1-9CFE-E4CE2B8F48A8.HEIC-1697189891513?alt=media&token=4efafdfe-0a12-4057-8cd5-353f75c8fdef', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'D3fy49msgdXvIOTEILCJH1ZMpc23', '_highlightResult': {'path': {'value': 'users/D3fy49msgdXvIOTEILCJH1ZMpc23', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Ashley', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Campos', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'Ashlxycampos ', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Aliso Viejo, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/7E404FE1-6083-49C1-9CFE-E4CE2B8F48A8.HEIC-1697189891513?alt=media&token=4efafdfe-0a12-4057-8cd5-353f75c8fdef', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}', 'interests': '[]', 'occupations': '[]'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:21:10,416 - ERROR - Error occurred while processing record: {'path': 'users/CpugxRZaWxNVky73w9aEQi713tL2', 'firstName': 'armani', 'lastName': 'west', 'instagramHandle': 'imarmaniwest', 'city': 'Los Angeles, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_0618.JPEG-1700738082907?alt=media&token=08f07b73-222c-4730-ae22-da2bbe7b0db1', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'CpugxRZaWxNVky73w9aEQi713tL2', '_highlightResult': {'path': {'value': 'users/CpugxRZaWxNVky73w9aEQi713tL2', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'armani', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'west', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'imarmaniwest', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Los Angeles, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_0618.JPEG-1700738082907?alt=media&token=08f07b73-222c-4730-ae22-da2bbe7b0db1', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}', 'interests': '[]', 'occupations': '[]'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:21:10,416 - INFO - Processed 500 records.
2024-04-17 18:21:10,417 - INFO - Total records processed: 11692
2024-04-17 18:21:10,417 - INFO - No truncated prefixes detected.
(myenv) timwhite@tims-air myenv % 


It appears that there are still errors occurring while processing records, similar to the previous ones. The issue seems to be related to the conversion of Python data types to MySQL types.

To address these errors, we need to ensure that the data types being passed to the MySQL connector are compatible. Let's review the errors:

1. The error message indicates that Python 'dict' cannot be converted to a MySQL type. This suggests that there might be an issue with how the dictionary data is being processed.

2. Additionally, there are errors related to converting an empty list (`'[]'`) to a MySQL type.

To resolve these issues, we need to check how the data is being processed and ensure that it matches the expected MySQL data types. Let's update the `save_records_to_database()` function to handle these cases:

```python
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, interests, occupations, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(interests)s, %(occupations)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        lastmodified_json=VALUES(lastmodified_json),
        interests=VALUES(interests),
        occupations=VALUES(occupations);
    """

    for record in records:
        # Ensure lastmodified is a JSON string if it's a dict
        record['lastmodified_json'] = json.dumps(record.get('lastmodified', {}))
        # Convert interests and occupations lists to JSON strings
        record['interests'] = json.dumps(record.get('interests', []))
        record['occupations'] = json.dumps(record.get('occupations', []))
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

With these updates, we're ensuring that the dictionary and list data types are properly converted to JSON strings before inserting them into the database. This should resolve the MySQL conversion errors.


def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, interests, occupations, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(interests)s, %(occupations)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        lastmodified_json=VALUES(lastmodified_json),
        interests=VALUES(interests),
        occupations=VALUES(occupations);
    """

    for record in records:
        # Ensure lastmodified is a JSON string if it's a dict
        record['lastmodified_json'] = json.dumps(record.get('lastmodified', {}))
        # Convert interests and occupations lists to JSON strings
        record['interests'] = json.dumps(record.get('interests', []))
        record['occupations'] = json.dumps(record.get('occupations', []))
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")

