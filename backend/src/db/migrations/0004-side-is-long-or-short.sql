-- A Leg's Side is long or short, not sold or bought (ADR 0013).
--
-- Data only: `legs` is a JSON array and its shape is unchanged, so schema.sql needs no edit and a
-- database built from it starts with no rows to rename.
--
-- Rewritten through the JSON functions rather than by text replacement. Rows that came across
-- from the Python database were written by json.dumps, which puts a space after every colon, so
-- '"side":"sold"' does not match them — a REPLACE would leave those legs saying "sold" for the
-- tightened LegOut to refuse at the first /positions call.
--
-- ORDER BY key keeps the legs in their stored order; a Position's legs are read positionally by
-- nothing, but the dashboard prints them in this order and a reshuffle would read as a change.
UPDATE positions
SET legs = (
  SELECT json_group_array(
    json(json_set(
      value, '$.side',
      CASE json_extract(value, '$.side')
        WHEN 'sold' THEN 'short'
        WHEN 'bought' THEN 'long'
        ELSE json_extract(value, '$.side')
      END
    ))
    ORDER BY key
  )
  FROM json_each(positions.legs)
)
WHERE EXISTS (
  SELECT 1 FROM json_each(positions.legs)
  WHERE json_extract(value, '$.side') IN ('sold', 'bought')
);
