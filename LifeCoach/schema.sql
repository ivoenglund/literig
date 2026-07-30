-- LITERIG Life Coach schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nutrition_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  diet_pattern TEXT NOT NULL DEFAULT 'vegan',
  allergies TEXT[] NOT NULL DEFAULT '{}',
  intolerances TEXT[] NOT NULL DEFAULT '{}',
  dislikes TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS food_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eaten_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('planned','confirmed','estimated','rejected')),
  source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text','voice','image','recipe')),
  quantity_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('exercise','sleep','weight','measurement','note')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  value_numeric NUMERIC,
  unit TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS food_entries_user_date_idx ON food_entries(user_id, eaten_at DESC);
ALTER TABLE food_entries ADD COLUMN IF NOT EXISTS nutrition_estimate JSONB;

CREATE TABLE IF NOT EXISTS recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  instructions TEXT,
  servings NUMERIC NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO recipes (name, description, instructions, servings) VALUES
('Heavy Metal Smoothie', 'Grön smoothie med spenat, koriander, apelsin och blåbär.', 'Mixa alla ingredienser tills smoothien är slät. Justera vatten efter önskad konsistens.', 1),
('Linssallad med potatis', 'Mättande sallad med linser, potatis och grönsaker.', 'Blanda kokta linser och potatis med grönsaker och dressing.', 1),
('Tofu med broccoli och ris', 'Varm vegansk måltid med tofu, broccoli och fullkornsris.', 'Stek tofu, tillsätt broccoli och servera med kokt ris.', 1),
('Havregrynsfrukost med blåbär', 'Enkel frukost med havregryn och bär.', 'Koka havregryn och toppa med blåbär.', 1)
ON CONFLICT (name) DO NOTHING;

INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount, unit, sort_order)
SELECT r.id, x.ingredient_name, x.amount, x.unit, x.sort_order FROM recipes r JOIN (VALUES
('Heavy Metal Smoothie','spenat',60,'g',1),('Heavy Metal Smoothie','koriander',20,'g',2),('Heavy Metal Smoothie','apelsin',1,'st',3),('Heavy Metal Smoothie','blåbär',100,'g',4),('Heavy Metal Smoothie','banan',1,'st',5),
('Linssallad med potatis','linser, kokta',180,'g',1),('Linssallad med potatis','potatis, kokt',200,'g',2),('Linssallad med potatis','tomat',100,'g',3),
('Tofu med broccoli och ris','tofu',150,'g',1),('Tofu med broccoli och ris','broccoli',200,'g',2),('Tofu med broccoli och ris','fullkornsris, kokt',180,'g',3),
('Havregrynsfrukost med blåbär','havregryn',60,'g',1),('Havregrynsfrukost med blåbär','blåbär',100,'g',2)
) AS x(recipe_name, ingredient_name, amount, unit, sort_order) ON r.name=x.recipe_name
WHERE NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.recipe_id=r.id AND ri.ingredient_name=x.ingredient_name);

CREATE TABLE IF NOT EXISTS recipe_entries (
  entry_id UUID PRIMARY KEY REFERENCES food_entries(id) ON DELETE CASCADE,
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
  ingredients_snapshot JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipe_entries_recipe_idx ON recipe_entries(recipe_id);
CREATE INDEX IF NOT EXISTS health_events_user_date_idx ON health_events(user_id, occurred_at DESC);

