

2024-04-17 19:08:42,522 - INFO - Fetched 500 new records with prefix 'g'. Page: 0.
2024-04-17 19:08:42,522 - INFO - Reached max records limit for prefix 'g'.
Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 543, in _process_params_dict
    conv = to_mysql(conv)
           ^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/conversion.py", line 236, in to_mysql
    raise TypeError(
TypeError: Python 'dict' cannot be converted to a MySQL type

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 130, in <module>
    main()
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 121, in main
    all_records, truncated_prefixes = process_prefixes(initial_prefixes, max_records=100)  # Set max_records for testing
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 109, in process_prefixes
    save_records_to_database(records)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/main.py", line 44, in save_records_to_database
    cursor.execute(add_record, record)
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 728, in execute
    stmt = _bytestr_format_dict(stmt, self._process_params_dict(params))
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/timwhite/Documents/GitHub/algoliascraoer/myenv/lib/python3.12/site-packages/mysql/connector/cursor.py", line 549, in _process_params_dict
    raise ProgrammingError(
mysql.connector.errors.ProgrammingError: Failed processing pyformat-parameters; Python 'dict' cannot be converted to a MySQL type
(myenv) timwhite@tims-air myenv % 


It seems that the issue persists even after adding the logging statements. Let's try a different approach to debug this.

Since the error occurs during the execution of the SQL statement, let's print out the SQL statement and the record just before executing it. This will help us identify any discrepancies between the record structure and the SQL statement.

Here's the updated `save_records_to_database` function with additional logging of the SQL statement and the record:

```python
def save_records_to_database(records):
    connection = get_db_connection()
    cursor = connection.cursor()

    # SQL statement to insert new records
    add_record = """
    INSERT INTO users
    (path, firstName, lastName, instagramHandle, city, photoUrl, gender, bio, isVerified, lastmodified_json, interests, occupations, objectID)
    VALUES (%(path)s, %(firstName)s, %(lastName)s, %(instagramHandle)s, %(city)s, %(photoUrl)s, %(gender)s, %(bio)s, %(isVerified)s, %(lastmodified_json)s, %(interests)s, %(occupations)s, %(objectID)s)
    """

    for record in records:
        try:
            # Log the record and SQL statement before executing the SQL statement
            logging.info(f


**Topic:** [[chatgpt-clusters/coding_devops]]
