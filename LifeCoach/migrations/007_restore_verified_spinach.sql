-- Restore a source ingredient only when it is absent from the standard recipe.
-- The record is the exact raw-spinach Fineli item (33456); historical day snapshots are untouched.
INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount, unit, food_id, sort_order)
SELECT r.id, 'spinach', 60, 'g', f.id, 1
FROM recipes r
JOIN foods f ON f.fineli_food_id=33456 AND f.status='verified' AND f.basis_amount=100 AND f.basis_unit='g'
WHERE r.name='Heavy Metal Smoothie'
  AND NOT EXISTS (
    SELECT 1 FROM recipe_ingredients ri
    WHERE ri.recipe_id=r.id AND ri.ingredient_name='spinach'
  );
