-- Every resumable Fineli import batch records its expected source size and result.
-- This is operational metadata only; nutrition calculations still use foods and food_nutrients.
CREATE TABLE IF NOT EXISTS nutrition_catalog_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL CHECK (source_name = 'Fineli'),
  source_version TEXT NOT NULL,
  requested_offset INTEGER NOT NULL CHECK (requested_offset >= 0),
  requested_limit INTEGER NOT NULL CHECK (requested_limit BETWEEN 1 AND 25),
  expected_foods INTEGER NOT NULL CHECK (expected_foods >= 0),
  expected_nutrients INTEGER NOT NULL CHECK (expected_nutrients >= 0),
  expected_nutrient_values INTEGER NOT NULL CHECK (expected_nutrient_values >= 0),
  imported_foods INTEGER NOT NULL CHECK (imported_foods >= 0),
  imported_nutrient_values INTEGER NOT NULL CHECK (imported_nutrient_values >= 0),
  completed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nutrition_catalog_import_runs_created_idx
  ON nutrition_catalog_import_runs (created_at DESC);
