ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS original_amount NUMERIC;
ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS original_unit TEXT;
ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS amount_grams NUMERIC;
