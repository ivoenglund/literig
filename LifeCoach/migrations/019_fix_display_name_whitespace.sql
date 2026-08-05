-- Migration 018 built display_name with split_part(name, ',', 2), which keeps the
-- space that follows the comma. For a name such as 'GINGER, GROUND' that produced
-- ' Ground Ginger' with a leading space, while the importer's fineliDisplayName()
-- produces 'Ground Ginger'. This aligns the stored values with the tested importer.
-- Presentation only: the raw Fineli name in foods.name is never touched.
UPDATE foods
SET display_name = btrim(regexp_replace(display_name, '\s+', ' ', 'g'))
WHERE display_name IS NOT NULL
  AND display_name <> btrim(regexp_replace(display_name, '\s+', ' ', 'g'));
