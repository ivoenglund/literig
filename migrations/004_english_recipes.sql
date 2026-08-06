-- Standard recipes are English. Historical recipe_entries remain untouched.
ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS food_id UUID REFERENCES foods(id);

UPDATE recipes SET
  name = 'Lentil and Potato Salad',
  description = 'A filling salad with lentils, potatoes and vegetables.',
  instructions = 'Combine cooked lentils and potatoes with vegetables and dressing.'
WHERE name = 'Linssallad med potatis';

UPDATE recipes SET
  name = 'Tofu with Broccoli and Brown Rice',
  description = 'A warm vegan meal with tofu, broccoli and brown rice.',
  instructions = 'Pan-fry the tofu, add broccoli, and serve with cooked brown rice.'
WHERE name = 'Tofu med broccoli och ris';

UPDATE recipes SET
  name = 'Oatmeal with Blueberries',
  description = 'A simple breakfast with rolled oats and berries.',
  instructions = 'Cook the rolled oats and top with blueberries.'
WHERE name = 'Havregrynsfrukost med blåbär';

UPDATE recipes SET
  description = 'A green smoothie with spinach, cilantro, orange and blueberries.',
  instructions = 'Blend all ingredients until smooth. Adjust water for the desired consistency.'
WHERE name = 'Heavy Metal Smoothie';

UPDATE recipe_ingredients SET ingredient_name='spinach' WHERE ingredient_name='spenat';
UPDATE recipe_ingredients SET ingredient_name='cilantro' WHERE ingredient_name='koriander';
UPDATE recipe_ingredients SET ingredient_name='orange' WHERE ingredient_name='apelsin';
UPDATE recipe_ingredients SET ingredient_name='blueberries' WHERE ingredient_name='blåbär';
UPDATE recipe_ingredients SET ingredient_name='banana' WHERE ingredient_name='banan';
UPDATE recipe_ingredients SET ingredient_name='lentils, cooked' WHERE ingredient_name='linser, kokta';
UPDATE recipe_ingredients SET ingredient_name='potato, boiled' WHERE ingredient_name='potatis, kokt';
UPDATE recipe_ingredients SET ingredient_name='tomato' WHERE ingredient_name='tomat';
UPDATE recipe_ingredients SET ingredient_name='rolled oats' WHERE ingredient_name='havregryn';
UPDATE recipe_ingredients SET ingredient_name='brown rice, cooked' WHERE ingredient_name='fullkornsris, kokt';
