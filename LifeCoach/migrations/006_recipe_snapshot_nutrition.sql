-- Nutrition for a logged recipe is resolved from this immutable snapshot only.
-- A missing food_id or a non-gram amount is deliberately retained as missing data.
CREATE INDEX IF NOT EXISTS recipe_ingredients_food_id_idx ON recipe_ingredients(food_id);
CREATE INDEX IF NOT EXISTS food_nutrients_nutrient_food_idx ON food_nutrients(nutrient_id, food_id);