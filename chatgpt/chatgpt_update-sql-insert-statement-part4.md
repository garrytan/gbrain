
It seems like there are still issues with the data format, specifically related to the 'lastmodified' field. Let's update the code to handle this case as well. Here's the revised version:

```python
import json
import mysql.connector
import logging

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
        lastmodified_json = json.dumps(record.get('lastmodified', {}))
        record['lastmodified_json'] = lastmodified_json
        # Check if 'interests' field exists and is not an empty array
        if 'interests' in record and record['interests'] == '[]':
            record['interests'] = None  # Set to None to skip insertion
        # Check if 'occupations' field exists
        if 'occupations' in record:
            # Check if 'occupations' is a string
            if isinstance(record['occupations'], str):
                record['occupations'] = json.loads(record['occupations']) if record['occupations'] else None
            # If 'occupations' is already a list, keep it as it is
            elif isinstance(record['occupations'], list):
                pass
            else:
                logging.error(f"Invalid format for 'occupations' field: {record['occupations']}")
                continue  # Skip this record
        # Check if 'lastmodified' field is a dictionary
        if isinstance(record['lastmodified'], dict):
            lastmodified_json = json.dumps(record['lastmodified'])
            record['lastmodified_json'] = lastmodified_json
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This code should handle the cases where the 'lastmodified' field is a dictionary and convert it to a JSON string before inserting it into the database. Let me know if you need further assistance!



2024-04-17 18:46:24,208 - INFO - Reached max records limit for prefix 'v'.
2024-04-17 18:46:24,217 - INFO - Fetched 418 new records with prefix 'w'. Page: 0.
2024-04-17 18:46:24,217 - INFO - Reached max records limit for prefix 'w'.
2024-04-17 18:46:24,584 - INFO - Fetched 500 new records with prefix 'h'. Page: 0.
2024-04-17 18:46:24,585 - INFO - Reached max records limit for prefix 'h'.
2024-04-17 18:46:24,594 - INFO - Fetched 500 new records with prefix 'f'. Page: 0.
2024-04-17 18:46:24,594 - INFO - Reached max records limit for prefix 'f'.
Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 163, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 154, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 142, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 73, in save_records_to_database
    if isinstance(record['lastmodified'], dict):
                  ~~~~~~^^^^^^^^^^^^^^^^
KeyError: 'lastmodified'


It appears there's an error because some records are missing the 'lastmodified' field. We can modify the code to handle this case gracefully. Here's the updated code:

```python
import json
import mysql.connector
import logging

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
        lastmodified_json = json.dumps(record.get('lastmodified', {}))
        record['lastmodified_json'] = lastmodified_json
        # Check if 'interests' field exists and is not an empty array
        if 'interests' in record and record['interests'] == '[]':
            record['interests'] = None  # Set to None to skip insertion
        # Check if 'occupations' field exists
        if 'occupations' in record:
            # Check if 'occupations' is a string
            if isinstance(record['occupations'], str):
                record['occupations'] = json.loads(record['occupations']) if record['occupations'] else None
            # If 'occupations' is already a list, keep it as it is
            elif isinstance(record['occupations'], list):
                pass
            else:
                logging.error(f"Invalid format for 'occupations' field: {record['occupations']}")
                continue  # Skip this record
        # Check if 'lastmodified' field exists and is a dictionary
        if 'lastmodified' in record and isinstance(record['lastmodified'], dict):
            lastmodified_json = json.dumps(record['lastmodified'])
            record['lastmodified_json'] = lastmodified_json
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This code should handle cases where the 'lastmodified' field is missing or is not a dictionary by checking if it exists before attempting to process it. Let me know if you need further assistance!



2024-04-17 18:47:13,777 - ERROR - Error occurred while processing record: {'path': 'users/XRdSYHGLehfvwnUuiTf3XpiwBLE3', 'firstName': 'Moses', 'lastName': 'Alem', 'instagramHandle': 'hokagemoe', 'city': 'Toronto, ON, Canada', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_1663.JPG-1694284725836?alt=media&token=d777e6b1-2f91-4f47-a036-123dcc335a89', 'gender': 'Male', 'isHost': True, 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'XRdSYHGLehfvwnUuiTf3XpiwBLE3', '_highlightResult': {'path': {'value': 'users/XRdSYHGLehfvwnUuiTf3XpiwBLE3', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Moses', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Alem', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'hokagemoe', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Toronto, ON, Canada', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_1663.JPG-1694284725836?alt=media&token=d777e6b1-2f91-4f47-a036-123dcc335a89', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Male', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}, 'lastmodified_json': '{"_operation": "IncrementSet", "value": 1713230726041}'}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:47:13,778 - INFO - Processed 500 records.
2024-04-17 18:47:13,779 - INFO - Total records processed: 11692
2024-04-17 18:47:13,779 - INFO - No truncated prefixes detected.
(myenv) timwhite@tims-air myenv % 


It seems there's still an error occurring while processing a record. The issue is with the 'lastmodified' field. Let's adjust the code to handle this scenario more effectively:

```python
import json
import mysql.connector
import logging

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
        lastmodified_json = json.dumps(record.get('lastmodified', {}))
        record['lastmodified_json'] = lastmodified_json
        # Check if 'interests' field exists and is not an empty array
        if 'interests' in record and record['interests'] == '[]':
            record['interests'] = None  # Set to None to skip insertion
        # Check if 'occupations' field exists
        if 'occupations' in record:
            # Check if 'occupations' is a string
            if isinstance(record['occupations'], str):
                record['occupations'] = json.loads(record['occupations']) if record['occupations'] else None
            # If 'occupations' is already a list, keep it as it is
            elif isinstance(record['occupations'], list):
                pass
            else:
                logging.error(f"Invalid format for 'occupations' field: {record['occupations']}")
                continue  # Skip this record
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This modification will ensure that the code gracefully handles cases where the 'lastmodified' field is missing or not a dictionary. Let me know if you need further assistance!


we dont need the last modified data


If you don't need the 'lastmodified' data, we can simplify the code by removing it from the SQL query and the processing loop. Here's the updated code without the 'lastmodified' field:

```python
import mysql.connector
import logging

def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, interests, occupations, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(interests)s, %(occupations)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified),
        interests=VALUES(interests),
        occupations=VALUES(occupations);
    """

    for record in records:
        # Check if 'interests' field exists and is not an empty array
        if 'interests' in record and record['interests'] == '[]':
            record['interests'] = None  # Set to None to skip insertion
        # Check if 'occupations' field exists
        if 'occupations' in record:
            # Check if 'occupations' is a string
            if isinstance(record['occupations'], str):
                record['occupations'] = json.loads(record['occupations']) if record['occupations'] else None
            # If 'occupations' is already a list, keep it as it is
            elif isinstance(record['occupations'], list):
                pass
            else:
                logging.error(f"Invalid format for 'occupations' field: {record['occupations']}")
                continue  # Skip this record
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This version of the code will ignore the 'lastmodified' field and only focus on the fields needed for insertion or update. Let me know if you have any questions!


we dont need occupation or interests either


Got it. If you don't need the 'occupations' or 'interests' fields, we can simplify the code further. Here's the updated version without those fields:

```python
import mysql.connector
import logging

def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        bio=VALUES(bio),
        isVerified=VALUES(isVerified);
    """

    for record in records:
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This version of the code removes the 'occupations' and 'interests' fields from the SQL statement and the processing loop, simplifying the data handling. Let me know if you have any further requests or questions!


bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:49:35,349 - ERROR - Error occurred while processing record: {'path': 'users/Ziscrxjohog0rpPsSQUI27JRqmn1', 'firstName': 'Ortensia', 'lastName': 'Sulku', 'instagramHandle': 'tessasulku', 'city': 'Mississauga, ON, Canada', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_3447.HEIC-1696539254978?alt=media&token=b07e361a-b18a-4bad-8d55-d52d2c64f52c', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'Ziscrxjohog0rpPsSQUI27JRqmn1', '_highlightResult': {'path': {'value': 'users/Ziscrxjohog0rpPsSQUI27JRqmn1', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Ortensia', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Sulku', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'tessasulku', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Mississauga, ON, Canada', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_3447.HEIC-1696539254978?alt=media&token=b07e361a-b18a-4bad-8d55-d52d2c64f52c', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:49:35,350 - ERROR - Error occurred while processing record: {'path': 'users/ZU2avBnRSdbA1INW8DbercBcqoo2', 'firstName': 'Reagan', 'lastName': 'Silvi', 'instagramHandle': '@reagan_ireland', 'city': 'New York, NY, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_9400.JPG-1695161449554?alt=media&token=ad30ed91-63d5-4bdf-94c3-1c9a647190b8', 'gender': 'Male', 'bio': '', 'occupations': [], 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'ZU2avBnRSdbA1INW8DbercBcqoo2', '_highlightResult': {'path': {'value': 'users/ZU2avBnRSdbA1INW8DbercBcqoo2', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Reagan', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Silvi', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': '@reagan_ireland', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'New York, NY, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_9400.JPG-1695161449554?alt=media&token=ad30ed91-63d5-4bdf-94c3-1c9a647190b8', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Male', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'list' cannot be converted to a MySQL type
2024-04-17 18:49:35,350 - INFO - Processed 500 records.
2024-04-17 18:49:35,351 - INFO - Total records processed: 11692
2024-04-17 18:49:35,351 - INFO - No truncated prefixes detected.


It looks like we're still encountering errors related to processing certain fields like 'bio', 'lastmodified', 'occupations', and 'interests'. Let's modify the code to exclude these fields entirely to prevent further errors. Here's the updated version:

```python
import mysql.connector
import logging

def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, isVerified, objectID)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(isVerified)s, %(objectID)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        isVerified=VALUES(isVerified);
    """

    for record in records:
        try:
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This version of the code removes the 'bio', 'lastmodified', 'occupations', and 'interests' fields from both the SQL statement and the processing loop. This should help avoid the errors related to these fields. Let me know if you need further assistance!


lets just convert a bio to plain text


Sure, we can modify the code to convert the 'bio' field to plain text before saving it to the database. Here's how you can do it:

```python
import mysql.connector
import logging
import html

def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, isVerified, objectID, bio)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(isVerified)s, %(objectID)s, %(bio)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        isVerified=VALUES(isVerified),
        bio=VALUES(bio);
    """

    for record in records:
        try:
            # Convert bio to plain text
            record['bio'] = html.unescape(record.get('bio', '')).strip()
            
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

In this version of the code, we use the `html.unescape()` function to convert any HTML entities to their corresponding characters and then `strip()` to remove any leading or trailing whitespace from the 'bio' field before saving it to the database. This ensures that the 'bio' field is stored as plain text.



2024-04-17 18:53:35,446 - ERROR - Error occurred while processing record: {'path': 'users/D3fy49msgdXvIOTEILCJH1ZMpc23', 'firstName': 'Ashley', 'lastName': 'Campos', 'instagramHandle': 'Ashlxycampos ', 'city': 'Aliso Viejo, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/7E404FE1-6083-49C1-9CFE-E4CE2B8F48A8.HEIC-1697189891513?alt=media&token=4efafdfe-0a12-4057-8cd5-353f75c8fdef', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'D3fy49msgdXvIOTEILCJH1ZMpc23', '_highlightResult': {'path': {'value': 'users/D3fy49msgdXvIOTEILCJH1ZMpc23', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Ashley', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Campos', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'Ashlxycampos ', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Aliso Viejo, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/7E404FE1-6083-49C1-9CFE-E4CE2B8F48A8.HEIC-1697189891513?alt=media&token=4efafdfe-0a12-4057-8cd5-353f75c8fdef', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:53:35,446 - ERROR - Error occurred while processing record: {'path': 'users/CpugxRZaWxNVky73w9aEQi713tL2', 'firstName': 'armani', 'lastName': 'west', 'instagramHandle': 'imarmaniwest', 'city': 'Los Angeles, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_0618.JPEG-1700738082907?alt=media&token=08f07b73-222c-4730-ae22-da2bbe7b0db1', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'CpugxRZaWxNVky73w9aEQi713tL2', '_highlightResult': {'path': {'value': 'users/CpugxRZaWxNVky73w9aEQi713tL2', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'armani', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'west', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'imarmaniwest', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Los Angeles, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_0618.JPEG-1700738082907?alt=media&token=08f07b73-222c-4730-ae22-da2bbe7b0db1', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:53:35,447 - INFO - Processed 500 records.
2024-04-17 18:53:35,448 - INFO - Total records processed: 11692
2024-04-17 18:53:35,448 - INFO - No truncated prefixes detected.
(myenv) timwhite@tims-air myenv % 


It seems like there are still errors occurring while processing records. Let's make sure that the changes to convert the 'bio' field to plain text were applied correctly. Here's the updated code with the modifications:

```python
import mysql.connector
import logging
import html

def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, isVerified, objectID, bio)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(isVerified)s, %(objectID)s, %(bio)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        isVerified=VALUES(isVerified),
        bio=VALUES(bio);
    """

    for record in records:
        try:
            # Convert bio to plain text
            record['bio'] = html.unescape(record.get('bio', '')).strip()
            
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

Please ensure that the changes have been applied correctly, and if the errors persist, we may need to investigate further to identify the root cause.



2024-04-17 18:54:42,632 - INFO - Fetched 203 new records with prefix 'z'. Page: 0.
2024-04-17 18:54:42,632 - INFO - Reached max records limit for prefix 'z'.
2024-04-17 18:54:42,860 - INFO - Fetched 500 new records with prefix 'b'. Page: 0.
2024-04-17 18:54:42,860 - INFO - Reached max records limit for prefix 'b'.
2024-04-17 18:54:42,903 - INFO - Fetched 500 new records with prefix 'e'. Page: 0.
2024-04-17 18:54:42,903 - INFO - Reached max records limit for prefix 'e'.
2024-04-17 18:54:42,912 - INFO - Fetched 500 new records with prefix 'd'. Page: 0.
2024-04-17 18:54:42,912 - INFO - Reached max records limit for prefix 'd'.
Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 142, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 133, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 121, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 56, in save_records_to_database
    record['bio'] = html.unescape(record.get('bio', '')).strip()
                    ^^^^
NameError: name 'html' is not defined. Did you forget to import 'html'?
(myenv) timwhite@tims-air myenv % 


It appears that there's an error because the `html` module is not imported. Let's fix this by importing the `html` module at the beginning of the script. Here's the updated code:

```python
import mysql.connector
import logging
import html  # Import the html module

def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, isVerified, objectID, bio)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(isVerified)s, %(objectID)s, %(bio)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        isVerified=VALUES(isVerified),
        bio=VALUES(bio);
    """

    for record in records:
        try:
            # Convert bio to plain text
            record['bio'] = html.unescape(record.get('bio', '')).strip()
            
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

With the `html` module imported, the script should now be able to properly handle the conversion of the bio field to plain text.


atchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:55:27,704 - ERROR - Error occurred while processing record: {'path': 'users/JzCp7PS05ddAaN4fQN2TG8GWuEG3', 'firstName': 'Gladys', 'lastName': 'Castaneda ', 'instagramHandle': 'Glad.sc', 'city': 'Los Angeles, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/DB6AEF8C-7B5E-40C4-AC8F-C427F5704125.JPG-1698263096024?alt=media&token=f4ba3592-6add-46d2-bfc4-442069ec09ae', 'gender': 'Female', 'bio': '', 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'JzCp7PS05ddAaN4fQN2TG8GWuEG3', '_highlightResult': {'path': {'value': 'users/JzCp7PS05ddAaN4fQN2TG8GWuEG3', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Gladys', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Castaneda ', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'Glad.sc', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Los Angeles, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/DB6AEF8C-7B5E-40C4-AC8F-C427F5704125.JPG-1698263096024?alt=media&token=f4ba3592-6add-46d2-bfc4-442069ec09ae', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:55:27,704 - ERROR - Error occurred while processing record: {'path': 'users/Jt87CuHmRkZhFwlHWVGvtVtPRec2', 'firstName': 'Katelyn', 'lastName': 'Contreras ', 'instagramHandle': 'kt_ct', 'city': 'Altadena, CA, USA', 'photoUrl': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_4557.HEIC-1692420709733?alt=media&token=0b431bbc-41a7-4e62-aa18-0bc84d5b703b', 'gender': 'Female', 'bio': '', 'interests': ['private_parties', 'dinner_events', 'clubs'], 'occupations': ['model'], 'isVerified': False, 'lastmodified': {'_operation': 'IncrementSet', 'value': 1713230726041}, 'objectID': 'Jt87CuHmRkZhFwlHWVGvtVtPRec2', '_highlightResult': {'path': {'value': 'users/Jt87CuHmRkZhFwlHWVGvtVtPRec2', 'matchLevel': 'none', 'matchedWords': []}, 'firstName': {'value': 'Katelyn', 'matchLevel': 'none', 'matchedWords': []}, 'lastName': {'value': 'Contreras ', 'matchLevel': 'none', 'matchedWords': []}, 'instagramHandle': {'value': 'kt_ct', 'matchLevel': 'none', 'matchedWords': []}, 'city': {'value': 'Altadena, CA, USA', 'matchLevel': 'none', 'matchedWords': []}, 'photoUrl': {'value': 'https://firebasestorage.googleapis.com:443/v0/b/promotr-app-7fcec.appspot.com/o/IMG_4557.HEIC-1692420709733?alt=media&token=0b431bbc-41a7-4e62-aa18-0bc84d5b703b', 'matchLevel': 'none', 'matchedWords': []}, 'gender': {'value': 'Female', 'matchLevel': 'none', 'matchedWords': []}, 'bio': {'value': '', 'matchLevel': 'none', 'matchedWords': []}, 'interests': [{'value': 'private_parties', 'matchLevel': 'none', 'matchedWords': []}, {'value': 'dinner_events', 'matchLevel': 'none', 'matchedWords': []}, {'value': 'clubs', 'matchLevel': 'none', 'matchedWords': []}], 'occupations': [{'value': 'model', 'matchLevel': 'none', 'matchedWords': []}], 'lastmodified': {'_operation': {'value': 'IncrementSet', 'matchLevel': 'none', 'matchedWords': []}, 'value': {'value': '1713230726041', 'matchLevel': 'none', 'matchedWords': []}}}}. Error: Failed processing pyformat-parameters; Python 'list' cannot be converted to a MySQL type
2024-04-17 18:55:27,704 - INFO - Processed 500 records.
2024-04-17 18:55:27,705 - INFO - Total records processed: 11692
2024-04-17 18:55:27,705 - INFO - No truncated prefixes detected.


It seems like there's an issue with the conversion of some data types to MySQL types in the script. Specifically, the error message mentions that Python 'dict' and 'list' cannot be converted to MySQL types. 

To address this, we need to ensure that only compatible data types are passed to MySQL. We can adjust the script to handle different data types properly. Here's an updated version of the `save_records_to_database` function:

```python
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records or update existing ones
    add_or_update_record = """
    INSERT INTO users
    (firstName, lastName, instagramHandle, city, photoUrl, gender, isVerified, objectID, bio)
    VALUES (%(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(isVerified)s, %(objectID)s, %(bio)s)
    ON DUPLICATE KEY UPDATE
        firstName=VALUES(firstName),
        lastName=VALUES(lastName),
        instagramHandle=VALUES(instagramHandle),
        city=VALUES(city),
        photoUrl=VALUES(photoUrl),
        gender=VALUES(gender),
        isVerified=VALUES(isVerified),
        bio=VALUES(bio);
    """

    for record in records:
        try:
            # Convert bio to plain text
            record['bio'] = html.unescape(record.get('bio', '')).strip()
            
            # Handle occupations and interests
            if 'occupations' in record:
                record['occupations'] = ', '.join(record['occupations'])
            if 'interests' in record:
                record['interests'] = ', '.join(record['interests'])
            
            cursor.execute(add_or_update_record, record)
        except mysql.connector.Error as err:
            logging.error(f"Error occurred while processing record: {record}. Error: {err}")

    connection.commit()
    cursor.close()
    connection.close()
    logging.info(f"Processed {len(records)} records.")
```

This updated version of the function properly handles the conversion of occupations and interests lists to strings before inserting them into the database. This should resolve the issue with data type conversion errors.


**Topic:** [[chatgpt-clusters/coding_devops]]
