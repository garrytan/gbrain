


The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 56, in save_records_to_database
    cursor.execute(add_or_update_record, record)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 728, in execute
    stmt = _bytestr_format_dict(stmt, self._process_params_dict(params))
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 549, in _process_params_dict
    raise ProgrammingError(
mysql.connector.errors.ProgrammingError: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 152, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 143, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 131, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 64, in save_records_to_database
    if err.errno == errorcode.ER_ACCESS_DENIED_ERROR:
                    ^^^^^^^^^
NameError: name 'errorcode' is not defined
(myenv) timwhite@tims-air myenv % python main.py

2024-04-17 18:08:24,065 - INFO - Fetched 500 new records with prefix 'i'. Page: 0.
2024-04-17 18:08:24,066 - INFO - Reached max records limit for prefix 'i'.
2024-04-17 18:08:24,106 - INFO - package: mysql.connector.plugins
2024-04-17 18:08:24,106 - INFO - plugin_name: caching_sha2_password
2024-04-17 18:08:24,106 - INFO - AUTHENTICATION_PLUGIN_CLASS: MySQLCachingSHA2PasswordAuthPlugin
2024-04-17 18:08:24,117 - INFO - Fetched 500 new records with prefix 'a'. Page: 0.
2024-04-17 18:08:24,117 - INFO - Reached max records limit for prefix 'a'.
2024-04-17 18:08:24,119 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,120 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,143 - INFO - Fetched 500 new records with prefix 'd'. Page: 0.
2024-04-17 18:08:24,144 - INFO - Reached max records limit for prefix 'd'.
2024-04-17 18:08:24,145 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,145 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,164 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,164 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,378 - INFO - Fetched 500 new records with prefix 'l'. Page: 0.
2024-04-17 18:08:24,378 - INFO - Reached max records limit for prefix 'l'.
2024-04-17 18:08:24,408 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,408 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,526 - INFO - Fetched 500 new records with prefix 'm'. Page: 0.
2024-04-17 18:08:24,526 - INFO - Reached max records limit for prefix 'm'.
2024-04-17 18:08:24,546 - INFO - Fetched 464 new records with prefix 'n'. Page: 0.
2024-04-17 18:08:24,546 - INFO - Reached max records limit for prefix 'n'.
2024-04-17 18:08:24,547 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,548 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,566 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,566 - INFO - Saved 464 records to the database.
2024-04-17 18:08:24,629 - INFO - Fetched 485 new records with prefix 'k'. Page: 0.
2024-04-17 18:08:24,629 - INFO - Reached max records limit for prefix 'k'.
2024-04-17 18:08:24,650 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,651 - INFO - Saved 485 records to the database.
2024-04-17 18:08:24,717 - INFO - Fetched 500 new records with prefix 'p'. Page: 0.
2024-04-17 18:08:24,717 - INFO - Reached max records limit for prefix 'p'.
2024-04-17 18:08:24,739 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,740 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,791 - INFO - Fetched 500 new records with prefix 'e'. Page: 0.
2024-04-17 18:08:24,791 - INFO - Reached max records limit for prefix 'e'.
2024-04-17 18:08:24,799 - INFO - Fetched 500 new records with prefix 'j'. Page: 0.
2024-04-17 18:08:24,799 - INFO - Reached max records limit for prefix 'j'.
2024-04-17 18:08:24,817 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,817 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,835 - INFO - Fetched 165 new records with prefix 'q'. Page: 0.
2024-04-17 18:08:24,835 - INFO - Reached max records limit for prefix 'q'.
2024-04-17 18:08:24,837 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,837 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,847 - INFO - Fetched 500 new records with prefix 'g'. Page: 0.
2024-04-17 18:08:24,847 - INFO - Reached max records limit for prefix 'g'.
2024-04-17 18:08:24,863 - INFO - Fetched 500 new records with prefix 'o'. Page: 0.
2024-04-17 18:08:24,863 - INFO - Reached max records limit for prefix 'o'.
2024-04-17 18:08:24,865 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,865 - INFO - Saved 165 records to the database.
2024-04-17 18:08:24,883 - INFO - Fetched 500 new records with prefix 'b'. Page: 0.
2024-04-17 18:08:24,883 - INFO - Reached max records limit for prefix 'b'.
2024-04-17 18:08:24,888 - INFO - Fetched 500 new records with prefix 'r'. Page: 0.
2024-04-17 18:08:24,888 - INFO - Reached max records limit for prefix 'r'.
2024-04-17 18:08:24,890 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'list' cannot be converted to a MySQL type
2024-04-17 18:08:24,890 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,909 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,909 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,926 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,927 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,945 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:24,945 - INFO - Saved 500 records to the database.
2024-04-17 18:08:24,978 - INFO - Fetched 260 new records with prefix 'y'. Page: 0.
2024-04-17 18:08:24,978 - INFO - Reached max records limit for prefix 'y'.
2024-04-17 18:08:24,997 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'list' cannot be converted to a MySQL type
2024-04-17 18:08:24,997 - INFO - Saved 260 records to the database.
2024-04-17 18:08:25,048 - INFO - Fetched 500 new records with prefix 'h'. Page: 0.
2024-04-17 18:08:25,048 - INFO - Reached max records limit for prefix 'h'.
2024-04-17 18:08:25,057 - INFO - Fetched 203 new records with prefix 'z'. Page: 0.
2024-04-17 18:08:25,057 - INFO - Reached max records limit for prefix 'z'.
2024-04-17 18:08:25,071 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,071 - INFO - Saved 500 records to the database.
2024-04-17 18:08:25,084 - INFO - Fetched 500 new records with prefix 'f'. Page: 0.
2024-04-17 18:08:25,084 - INFO - Reached max records limit for prefix 'f'.
2024-04-17 18:08:25,093 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,093 - INFO - Saved 203 records to the database.
2024-04-17 18:08:25,105 - INFO - Fetched 500 new records with prefix 'c'. Page: 0.
2024-04-17 18:08:25,105 - INFO - Reached max records limit for prefix 'c'.
2024-04-17 18:08:25,118 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,118 - INFO - Saved 500 records to the database.
2024-04-17 18:08:25,137 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,137 - INFO - Saved 500 records to the database.
2024-04-17 18:08:25,156 - INFO - Fetched 418 new records with prefix 'w'. Page: 0.
2024-04-17 18:08:25,156 - INFO - Reached max records limit for prefix 'w'.
2024-04-17 18:08:25,160 - INFO - Fetched 197 new records with prefix 'x'. Page: 0.
2024-04-17 18:08:25,160 - INFO - Reached max records limit for prefix 'x'.
2024-04-17 18:08:25,182 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,182 - INFO - Saved 418 records to the database.
2024-04-17 18:08:25,200 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,200 - INFO - Saved 197 records to the database.
2024-04-17 18:08:25,292 - INFO - Fetched 500 new records with prefix 'u'. Page: 0.
2024-04-17 18:08:25,292 - INFO - Reached max records limit for prefix 'u'.
2024-04-17 18:08:25,312 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,313 - INFO - Saved 500 records to the database.
2024-04-17 18:08:25,362 - INFO - Fetched 500 new records with prefix 't'. Page: 0.
2024-04-17 18:08:25,362 - INFO - Reached max records limit for prefix 't'.
2024-04-17 18:08:25,380 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,380 - INFO - Saved 500 records to the database.
2024-04-17 18:08:25,395 - INFO - Fetched 500 new records with prefix 's'. Page: 0.
2024-04-17 18:08:25,395 - INFO - Reached max records limit for prefix 's'.
2024-04-17 18:08:25,422 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,422 - INFO - Saved 500 records to the database.
2024-04-17 18:08:25,448 - INFO - Fetched 500 new records with prefix 'v'. Page: 0.
2024-04-17 18:08:25,448 - INFO - Reached max records limit for prefix 'v'.
2024-04-17 18:08:25,466 - ERROR - MySQL Error: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
2024-04-17 18:08:25,466 - INFO - Saved 500 records to the database.
2024-04-17 18:08:25,467 - INFO - Total records processed: 11692
2024-04-17 18:08:25,467 - INFO - No truncated prefixes detected.


To handle duplicates effectively and update existing records where the `objectID` matches, you can modify your SQL insertion statement to use `ON DUPLICATE KEY UPDATE`. This will allow MySQL to update the record if an existing `objectID` is found, rather than trying to insert a new one. Here is how you can adapt your insertion script:

1. **Ensure your table has a UNIQUE constraint on the `objectID` column**. This makes the `ON DUPLICATE KEY UPDATE` mechanism work, as it relies on a uniqueness constraint to determine when to update instead of insert.

2. **Modify the SQL statement in your Python script** to handle the insertion or update logic. This part of the script will check if the record exists and either update the existing record or insert a new one if it does not exist.

Here's an example of how you can modify your SQL execution statement in your script:

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
```

### What does this do?
- **`INSERT INTO users (...) VALUES (...) ON DUPLICATE KEY UPDATE ...`**: This part of the SQL statement tries to insert a new row into the users table. If a row with the same `objectID` already exists (due to the UNIQUE constraint), it updates that row instead of inserting a new one.
- **`VALUES(...)` in the `ON DUPLICATE KEY UPDATE` clause**: This uses the values provided in the `INSERT` part of the statement for the update. This means it will update the fields to the new values that would have been inserted.

This setup should effectively prevent duplicates by updating existing records with new information from your fetched data, addressing the issue with duplicates in your database.



2024-04-17 18:12:13,786 - INFO - Reached max records limit for prefix 'c'.
Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 543, in _process_params_dict
    conv = to_mysql(conv)
           ^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/conversion.py", line 236, in to_mysql
    raise TypeError(
TypeError: Python 'dict' cannot be converted to a MySQL type

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 142, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 133, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 121, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 57, in save_records_to_database
    cursor.execute(add_or_update_record, record)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 728, in execute
    stmt = _bytestr_format_dict(stmt, self._process_params_dict(params))
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 549, in _process_params_dict
    raise ProgrammingError(
mysql.connector.errors.ProgrammingError: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
(myenv) timwhite@tims-air myenv % 


It seems there's an issue converting a Python dictionary to a MySQL type. This error is occurring during the processing of parameters in the cursor execution.

The error suggests that the dictionary passed as parameters to the `cursor.execute()` method cannot be converted to a MySQL type. This could be due to a mismatch between the dictionary keys and the placeholders in the SQL query, or it could be related to the data types of the values in the dictionary.

To resolve this issue, ensure that:

1. The keys in the dictionary match the placeholders in the SQL query.
2. The data types of the values in the dictionary are compatible with the corresponding columns in the database table.

If the issue persists, you may need to provide more specific information about the code and the data being processed so that we can identify the root cause of the problem.
