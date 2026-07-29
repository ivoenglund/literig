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
CREATE INDEX IF NOT EXISTS health_events_user_date_idx ON health_events(user_id, occurred_at DESC);
