---
name: postgresql-code-review
description: 'PostgreSQL-specific code review assistant focusing on PostgreSQL best practices, anti-patterns, and unique quality standards. Covers JSONB operations, array usage, custom types, schema design, function optimization, and PostgreSQL-exclusive security features like Row Level Security (RLS).'
triggers:
  - "postgresql-code-review"
  - "postgresql code review"
  - "awesome copilot postgresql code review"
---

# PostgreSQL Code Review Assistant

Expert PostgreSQL code review for ${selection} (or entire project if no selection). Focus on PostgreSQL-specific best practices, anti-patterns, and quality standards that are unique to PostgreSQL.

## 🎯 PostgreSQL-Specific Review Areas

### JSONB Best Practices
```sql
-- ❌ BAD: Inefficient JSONB usage
SELECT * FROM orders WHERE data->>'status' = 'shipped';  -- No index support

-- ✅ GOOD: Indexable JSONB queries
CREATE INDEX idx_orders_status ON orders USING gin((data->'status'));
SELECT * FROM orders WHERE data @> '{"status": "shipped"}';

-- ❌ BAD: Deep nesting without consideration
UPDATE orders SET data = data || '{"shipping":{"tracking":{"number":"123"}}}';

-- ✅ GOOD: Structured JSONB with validation
ALTER TABLE orders ADD CONSTRAINT valid_status 
CHECK (data->>'status' IN ('pending', 'shipped', 'delivered'));
```

### Array Operations Review
```sql
-- ❌ BAD: Inefficient array operations
SELECT * FROM products WHERE 'electronics' = ANY(categories);  -- No index

-- ✅ GOOD: GIN indexed array queries
CREATE INDEX idx_products_categories ON products USING gin(categories);
SELECT * FROM products WHERE categories @> ARRAY['electronics'];

-- ❌ BAD: Array concatenation in loops
-- This would be inefficient in a function/procedure

-- ✅ GOOD: Bulk array operations
UPDATE products SET categories = categories || ARRAY['new_category']
WHERE id IN (SELECT id FROM products WHERE condition);
```

### PostgreSQL Schema Design Review
```sql
-- ❌ BAD: Not using PostgreSQL features
CREATE TABLE users (
    id INTEGER,
    email VARCHAR(255),
    created_at TIMESTAMP
);

-- ✅ GOOD: PostgreSQL-optimized schema
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email CITEXT UNIQUE NOT NULL,  -- Case-insensitive email
    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    CONSTRAINT valid_email CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

-- Add JSONB GIN index for metadata queries
CREATE INDEX idx_users_metadata ON users USING gin(metadata);
```

### Custom Types and Domains
```sql
-- ❌ BAD: Using generic types for specific data
CREATE TABLE transactions (
    amount DECIMAL(10,2),
    currency VARCHAR(3),
    status VARCHAR(20)
);

-- ✅ GOOD: PostgreSQL custom types
CREATE TYPE currency_code AS ENUM ('USD', 'EUR', 'GBP', 'JPY');
CREATE TYPE transaction_status AS ENUM ('pending', 'completed', 'failed', 'cancelled');
CREATE DOMAIN positive_amount AS DECIMAL(10,2) CHECK (VALUE > 0);

CREATE TABLE transactions (
    amount positive_amount NOT NULL,
    currency currency_code NOT NULL,
    status transaction_status DEFAULT 'pending'
);
```

## 🔍 PostgreSQL-Specific Anti-Patterns

### Performance Anti-Patterns
- **Avoiding PostgreSQL-specific indexes**: Not using GIN/GiST for appropriate data types
- **Misusing JSONB**: Treating JSONB like a simple string field
- **Ignoring array operators**: Using inefficient array operations
- **Poor partition key selection**: Not leveraging PostgreSQL partitioning effectively

### Schema Design Issues
- **Not using ENUM types**: Using VARCHAR for limited value sets
- **Ignoring constraints**: Missing CHECK constraints for data validation
- **Wrong data types**: Using VARCHAR instead of TEXT or CITEXT
- **Missing JSONB structure**: Unstructured JSONB without validation

### Function and Trigger Issues
```sql
-- ❌ BAD: Inefficient trigger function
CREATE OR REPLACE FUNCTION update_modified_time()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();  -- Should use TIMESTAMPTZ
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ✅ GOOD: Optimized trigger function
CREATE OR REPLACE FUNCTION update_modified_time()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Set trigger to fire only when needed
CREATE TRIGGER update_modified_time_trigger
    BEFORE UPDATE ON table_name
    FOR EACH ROW
    WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION update_modified_time();
```

## 📊 PostgreSQL Extension Usage Review

### Extension Best Practices
```sql
-- ✅ Check if extension exists before creating
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ✅ Use extensions appropriately
-- UUID generation
SELECT uuid_generate_v4();

-- Password hashing
SELECT crypt('password', gen_salt('bf'));

-- Fuzzy text matching
SELECT word_similarity('postgres', 'postgre');
```

## 🛡️ PostgreSQL Security Review

### Row Level Security (RLS)
```sql
-- ✅ GOOD: Implementing RLS
ALTER TABLE sensitive_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_data_policy ON sensitive_data
    FOR ALL TO application_role
    USING (user_id = current_setting('app.current_user_id')::INTEGER);
```

### Privilege Management
```sql
-- ❌ BAD: Overly broad permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_user;

-- ✅ GOOD: Granular permissions
GRANT SELECT, INSERT, UPDATE ON specific_table TO app_user;
GRANT USAGE ON SEQUENCE specific_table_id_seq TO app_user;
```

## 🎯 PostgreSQL Code Quality Checklist

### Schema Design
- [ ] Using appropriate PostgreSQL data types (CITEXT, JSONB, arrays)
- [ ] Leveraging ENUM types for constrained values
- [ ] Implementing proper CHECK constraints
- [ ] Using TIMESTAMPTZ instead of TIMESTAMP
- [ ] Defining custom domains for reusable constraints

### Performance Considerations
- [ ] Appropriate index types (GIN for JSONB/arrays, GiST for ranges)
- [ ] JSONB queries using containment operators (@>, ?)
- [ ] Array operations using PostgreSQL-specific operators
- [ ] Proper use of window functions and CTEs
- [ ] Efficient use of PostgreSQL-specific functions

### PostgreSQL Features Utilization
- [ ] Using extensions where appropriate
- [ ] Implementing stored procedures in PL/pgSQL when beneficial
- [ ] Leveraging PostgreSQL's advanced SQL features
- [ ] Using PostgreSQL-specific optimization techniques
- [ ] Implementing proper error handling in functions

### Security and Compliance
- [ ] Row Level Security (RLS) implementation where needed
- [ ] Proper role and privilege management
- [ ] Using PostgreSQL's built-in encryption functions
- [ ] Implementing audit trails with PostgreSQL features

## 📝 PostgreSQL-Specific Review Guidelines

1. **Data Type Optimization**: Ensure PostgreSQL-specific types are used appropriately
2. **Index Strategy**: Review index types and ensure PostgreSQL-specific indexes are utilized
3. **JSONB Structure**: Validate JSONB schema design and query patterns
4. **Function Quality**: Review PL/pgSQL functions for efficiency and best practices
5. **Extension Usage**: Verify appropriate use of PostgreSQL extensions
6. **Performance Features**: Check utilization of PostgreSQL's advanced features
7. **Security Implementation**: Review PostgreSQL-specific security features

Focus on PostgreSQL's unique capabilities and ensure the code leverages what makes PostgreSQL special rather than treating it as a generic SQL database.


## Contract

This skill guarantees:

- Implements the upstream GitHub awesome-copilot skill intent for `postgresql-code-review`: PostgreSQL-specific code review assistant focusing on PostgreSQL best practices, anti-patterns, and unique quality standards. Covers JSONB operations, array usage, custom types, schema design, function optimization, and 
- Uses only task-relevant references/scripts/assets from this skill directory.
- Produces source-grounded, concrete output: commands, code changes, configuration, review notes, diagrams, or checklists as the source skill requires.
- Does not invent APIs, tool behavior, repository facts, cloud settings, credentials, or user/project context not present in the repo or supplied by the user.

## Output Format

Lead with the actionable result. For implementation or automation tasks, list changed files/commands and verification output. For advisory/review tasks, return concise findings or steps with relevant paths. Do not dump whole reference files; cite the file path and include only the decisive excerpt.

## Anti-Patterns

- Applying this skill outside its documented domain when a narrower skill exists.
- Fabricating project structure, APIs, credentials, external account state, or cloud resources.
- Copying large references/assets into chat instead of using targeted excerpts.
- Skipping verification after code, config, or workflow changes.
