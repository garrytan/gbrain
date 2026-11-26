

const PRIVACY_LABEL_SQL = `WITH hits AS (SELECT p.frontmatter FROM pages p
          WHERE p.deleted_at IS NULL 
            AND (p.frontmatter ? 'access' OR p.frontmatter ? 'confidentiality') AND (p.frontmatter->>'visibility' IS NULL AND NOT (COALESCE(translate(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('private','restricted','confidential'), false) OR COALESCE(translate(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') IN ('confidential','secret','private','restricted'), false))
    AND p.frontmatter->>'pinned_question' IS NULL AND COALESCE(p.type, '') NOT IN ('atom', 'question')
    AND NOT (p.type = 'concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)
    AND NOT (p.type = 'event' AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')
    AND p.frontmatter->>'derived_from' IS NULL AND p.frontmatter->>'source_slug' IS NULL
    AND (NULLIF(btrim(p.frontmatter->>'access', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL OR NULLIF(btrim(p.frontmatter->>'confidentiality', (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL))
          LIMIT 100001)
       SELECT l.key, l.raw, l.is_string, count(*)::int AS pages, (SELECT count(*)::int FROM hits) AS scanned, (count(*) OVER ())::int AS groups
       FROM hits p CROSS JOIN LATERAL (VALUES ('access', p.frontmatter->>'access', jsonb_typeof(p.frontmatter->'access') = 'string'), ('confidentiality', p.frontmatter->>'confidentiality', jsonb_typeof(p.frontmatter->'confidentiality') = 'string')) AS l(key, raw, is_string)
       WHERE NULLIF(btrim(l.raw, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '') IS NOT NULL
       GROUP BY l.key, l.raw, l.is_string
       ORDER BY pages DESC, l.key COLLATE "C", l.raw COLLATE "C", l.is_string
       LIMIT 50`;
