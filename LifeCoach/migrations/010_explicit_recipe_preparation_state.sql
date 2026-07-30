-- Every recipe ingredient must carry an explicit preparation state. Unknown
-- states stay visible and are not silently treated as raw or cooked.
ALTER TABLE recipe_ingredients
  ADD COLUMN IF NOT EXISTS preparation_state TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (preparation_state IN ('raw', 'cooked', 'dry', 'powdered', 'frozen', 'fortified', 'volume', 'unresolved'));

CREATE INDEX IF NOT EXISTS recipe_ingredients_preparation_state_idx
  ON recipe_ingredients(preparation_state);
