-- Link only verified, unambiguous recipe ingredients to exact Fineli food records.
-- Potato and brown rice remain intentionally unmatched pending a cooked-state match.
UPDATE recipe_ingredients ri SET food_id=f.id
FROM foods f
WHERE (ri.ingredient_name, f.fineli_food_id) IN (
  ('tofu',33501),
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
