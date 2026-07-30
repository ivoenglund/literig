-- Versioned review layer for future Fineli/USDA updates.
-- Staged rows are never used by nutrition totals until an operator applies
-- an explicit, reviewed migration to foods/food_nutrients.
CREATE TABLE IF NOT EXISTS nutrition_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name TEXT NOT NULL CHECK (source_name IN ('Fineli','USDA FoodData Central')),
  source_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','applied','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS nutrition_import_staging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES nutrition_import_batches(id) ON DELETE CASCADE,
  source_record_id TEXT NOT NULL,
  english_name TEXT NOT NULL,
  name_sv TEXT,
  name_fi TEXT,
  state TEXT NOT NULL,
  basis_amount NUMERIC NOT NULL CHECK (basis_amount = 100),
  basis_unit TEXT NOT NULL CHECK (basis_unit = 'g'),
  proposed_nutrients JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','accepted','rejected','missing_data')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_record_id)
);

CREATE INDEX IF NOT EXISTS nutrition_import_staging_review_idx
  ON nutrition_import_staging(batch_id, decision, english_name);