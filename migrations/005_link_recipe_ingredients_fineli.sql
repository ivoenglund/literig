-- Link only verified, unambiguous recipe ingredients to exact Fineli food records.
-- Tofu, potato and brown rice remain intentionally unmatched: the recipe does
-- not declare the Fineli tofu texture, or the needed potato/rice preparation.
-- Never overwrite a link explicitly selected later by the user.
UPDATE recipe_ingredients ri SET food_id=f.id
FROM foods f
WHERE ri.food_id IS NULL
  AND (ri.ingredient_name, f.fineli_food_id) IN (
  ('lentils, cooked',31225),
  ('broccoli',324),
  ('rolled oats',153),
  ('spinach',33456),
  ('cilantro',34238),
  ('orange',11045),
  ('blueberries',442),
  ('banana',11049),
  ('tomato',352)
);
