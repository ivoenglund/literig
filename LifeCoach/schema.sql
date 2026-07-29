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
CREATE TABLE IF NOT EXISTS food_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  kcal_per_100g NUMERIC NOT NULL,
  protein_g_per_100g NUMERIC NOT NULL DEFAULT 0,
  fiber_g_per_100g NUMERIC NOT NULL DEFAULT 0,
  calcium_mg_per_100g NUMERIC NOT NULL DEFAULT 0,
  iron_mg_per_100g NUMERIC NOT NULL DEFAULT 0,
  source_note TEXT NOT NULL DEFAULT 'standardvärde; kontrollera mot etikett vid behov',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO food_catalog (name, kcal_per_100g, protein_g_per_100g, fiber_g_per_100g, calcium_mg_per_100g, iron_mg_per_100g)
VALUES
  ('tofu', 144, 17.3, 2.3, 683, 2.7),
  ('linser, kokta', 116, 9.0, 7.9, 19, 3.3),
  ('broccoli', 34, 2.8, 2.6, 47, 0.7),
  ('havregryn', 389, 16.9, 10.6, 54, 4.7),
  ('potatis, kokt', 87, 1.9, 1.8, 5, 0.3)
ON CONFLICT (name) DO NOTHING;

CREATE INDEX IF NOT EXISTS health_events_user_date_idx ON health_events(user_id, occurred_at DESC);
