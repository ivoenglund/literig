-- The seed recipe calls this ingredient only "tofu", while Fineli distinguishes
-- soft and firm tofu. Do not model either as the other. This changes only the
-- standard recipe; immutable day snapshots stay historical records.
UPDATE recipe_ingredients ri
SET food_id = NULL
FROM recipes r, foods f
WHERE ri.recipe_id = r.id
  AND r.name = 'Tofu with Broccoli and Brown Rice'
  AND ri.ingredient_name = 'tofu'
  AND ri.food_id = f.id
  AND f.fineli_food_id IN (33501, 35619);