-- Portion of a recipe that was actually eaten on the selected day.
ALTER TABLE recipe_entries
  ADD COLUMN IF NOT EXISTS consumption_fraction NUMERIC(5,4) NOT NULL DEFAULT 1;

ALTER TABLE recipe_entries
  DROP CONSTRAINT IF EXISTS recipe_entries_consumption_fraction_check;

ALTER TABLE recipe_entries
  ADD CONSTRAINT recipe_entries_consumption_fraction_check
  CHECK (consumption_fraction >= 0 AND consumption_fraction <= 1);
