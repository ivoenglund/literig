CREATE OR REPLACE FUNCTION clear_recipe_external_image_url()
RETURNS trigger AS $$
BEGIN
  NEW.image_url := NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recipes_no_external_image_url ON recipes;
CREATE TRIGGER recipes_no_external_image_url
BEFORE INSERT OR UPDATE OF image_url ON recipes
FOR EACH ROW EXECUTE FUNCTION clear_recipe_external_image_url();
