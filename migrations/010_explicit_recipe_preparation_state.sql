-- Every recipe ingredient must carry an explicit preparation state. Unknown
-- states stay visible and are not silently treated as raw or cooked.
ALTER TABLE recipe_ingredients
  ADD COLUMN IF NOT EXISTS preparation_state TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (preparation_state IN ('raw', 'cooked', 'dry', 'powdered', 'frozen', 'fortified', 'volume', 'unresolved'));

CREATE INDEX IF NOT EXISTS recipe_ingredients_preparation_state_idx
  ON recipe_ingredients(preparation_state);

-- Make the shipped recipes explicit without guessing ambiguous matches. These
-- names are already tied to a preparation-specific ingredient or an unprepared
-- whole food; unresolved remains the safe default for everything else.
UPDATE recipe_ingredients
SET preparation_state = CASE ingredient_name
  WHEN 'lentils, cooked' THEN 'cooked'
  WHEN 'potato, boiled' THEN 'cooked'
  WHEN 'brown rice, cooked' THEN 'cooked'
  WHEN 'rolled oats' THEN 'dry'
  WHEN 'spinach' THEN 'raw'
  WHEN 'cilantro' THEN 'raw'
  WHEN 'orange' THEN 'raw'
  WHEN 'blueberries' THEN 'raw'
  WHEN 'banana' THEN 'raw'
  WHEN 'tomato' THEN 'raw'
  WHEN 'broccoli' THEN 'raw'
  ELSE preparation_state
END
WHERE ingredient_name IN (
  'lentils, cooked', 'potato, boiled', 'brown rice, cooked',
  'rolled oats', 'spinach', 'cilantro', 'orange', 'blueberries',
  'banana', 'tomato', 'broccoli'
);
