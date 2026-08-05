-- Fineli CSV (component.csv) lower-case codes are the only canonical nutrient codes.
-- Legacy aliases are merged below before their nutrient rows are removed.
ALTER TABLE foods ADD COLUMN IF NOT EXISTS fineli_food_id INTEGER;
ALTER TABLE foods ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE foods ADD COLUMN IF NOT EXISTS name_sv TEXT;
ALTER TABLE foods ADD COLUMN IF NOT EXISTS name_fi TEXT;
ALTER TABLE foods ADD COLUMN IF NOT EXISTS edible_portion_percent NUMERIC;
CREATE UNIQUE INDEX IF NOT EXISTS foods_fineli_food_id_unique ON foods (fineli_food_id) WHERE fineli_food_id IS NOT NULL;
ALTER TABLE food_nutrients DROP CONSTRAINT IF EXISTS food_nutrients_value_nonnegative;
ALTER TABLE food_nutrients ADD CONSTRAINT food_nutrients_value_nonnegative CHECK (value >= 0) NOT VALID;

-- A recoverable, in-database backup is made and verified before any repair mutation.
CREATE TABLE IF NOT EXISTS nutrition_data_repair_backup_20260806 AS
SELECT now() AS backed_up_at, f.*, COALESCE((SELECT jsonb_agg(to_jsonb(fn)) FROM food_nutrients fn WHERE fn.food_id=f.id), '[]'::jsonb) AS nutrient_rows
FROM foods f;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM nutrition_data_repair_backup_20260806 LIMIT 1) AND EXISTS (SELECT 1 FROM foods LIMIT 1) THEN
    RAISE EXCEPTION 'nutrition repair backup was not created';
  END IF;
END $$;

-- Permit retirement of legacy identity rows without losing historical references.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='foods'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
    EXECUTE format('ALTER TABLE foods DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE foods ADD CONSTRAINT foods_status_check CHECK (status IN ('verified','planning','missing_data','deprecated'));

-- Correct canonical metadata. These values are the approved Fineli user-facing vocabulary.
WITH canonical(code,name,unit,category) AS (VALUES
('enerc','Energy','kJ','energy'),('energy_kcal','Energy','kcal','energy'),('fat','Fat, total','g','macronutrient'),('choavl','Carbohydrate, available','g','macronutrient'),('prot','Protein','g','macronutrient'),('alc','Alcohol','g','macronutrient'),('oa','Organic acids, total','g','carbohydrate'),('sugoh','Sugar alcohols','g','carbohydrate'),('sugar','Sugars, total','g','carbohydrate'),('frus','Fructose','g','carbohydrate'),('gals','Galactose','g','carbohydrate'),('glus','Glucose','g','carbohydrate'),('lacs','Lactose','g','carbohydrate'),('mals','Maltose','g','carbohydrate'),('sucs','Sucrose','g','carbohydrate'),('starch','Starch','g','carbohydrate'),('fibc','Fibre, total','g','macronutrient'),('fibins','Fibre, insoluble','g','carbohydrate'),('psacncs','Non-cellulosic polysaccharides, soluble','g','carbohydrate'),('fol','Folate','µg','vitamin'),('niaeq','Niacin equivalents','mg','vitamin'),('nia','Niacin (B3)','mg','vitamin'),('vitpyrid','Vitamin B6','mg','vitamin'),('ribf','Riboflavin (B2)','mg','vitamin'),('thia','Thiamin (B1)','mg','vitamin'),('vita','Vitamin A (RAE)','µg','vitamin'),('carotens','Carotenoids','µg','vitamin'),('vitb12','Vitamin B12','µg','vitamin'),('vitc','Vitamin C','mg','vitamin'),('vitd','Vitamin D','µg','vitamin'),('vite','Vitamin E (alpha-tocopherol)','mg','vitamin'),('vitk','Vitamin K','µg','vitamin'),('ca','Calcium','mg','mineral'),('fe','Iron','mg','mineral'),('id','Iodine','µg','mineral'),('k','Potassium','mg','mineral'),('mg','Magnesium','mg','mineral'),('na','Sodium','mg','mineral'),('nacl','Salt','mg','mineral'),('p','Phosphorus','mg','mineral'),('se','Selenium','µg','mineral'),('zn','Zinc','mg','mineral'),('fafre','Fatty acids, total','g','fat'),('fapu','Polyunsaturated fat','g','fat'),('famcis','Monounsaturated fat','g','fat'),('fasat','Saturated fat','g','fat'),('fatrn','Trans fat','g','fat'),('fapun3','Omega-3 fatty acids, total','g','fat'),('fapun6','Omega-6 fatty acids, total','g','fat'),('f18d2cn6','Linoleic acid (LA)','mg','fat'),('f18d3n3','Alpha-linolenic acid (ALA)','mg','fat'),('f20d5n3','EPA','mg','fat'),('f22d6n3','DHA','mg','fat'),('chole','Cholesterol','mg','fat'),('stert','Sterols, total','mg','fat'),('trp','Tryptophan','mg','amino acid') )
INSERT INTO nutrients(code,name,unit,category) SELECT * FROM canonical ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,unit=EXCLUDED.unit,category=EXCLUDED.category;

-- Move references first. Existing canonical Fineli CSV values win any conflict.
WITH aliases(old_code,canonical_code) AS (VALUES
('protein','prot'),('calcium','ca'),('iron','fe'),('zinc','zn'),('selenium','se'),('iodine','id'),('vitamin_b12','vitb12'),('vitamin_d','vitd'),('fiber','fibc'),('fibt','fibc'),('omega_3_ala','f18d3n3'),('cho','choavl'),('polyl','sugoh'),('vitb6','vitpyrid'),('chorl','chole'),('famscis','famcis'),('fatrs','fatrn'),('f18:2cn6','f18d2cn6'),('f18:3cn3','f18d3n3'),('f20:5cn3','f20d5n3'),('f22:6cn3','f22d6n3'))
INSERT INTO food_nutrients(food_id,nutrient_id,value,source_name,source_id)
SELECT fn.food_id, canonical.id, fn.value, fn.source_name, fn.source_id FROM food_nutrients fn JOIN nutrients old ON old.id=fn.nutrient_id JOIN aliases a ON a.old_code=old.code JOIN nutrients canonical ON canonical.code=a.canonical_code
ON CONFLICT(food_id,nutrient_id) DO NOTHING;
WITH aliases(old_code) AS (VALUES ('protein'),('calcium'),('iron'),('zinc'),('selenium'),('iodine'),('vitamin_b12'),('vitamin_d'),('fiber'),('fibt'),('omega_3_ala'),('cho'),('polyl'),('vitb6'),('chorl'),('famscis'),('fatrs'),('f18:2cn6'),('f18:3cn3'),('f20:5cn3'),('f22:6cn3'))
DELETE FROM food_nutrients fn USING nutrients n, aliases a WHERE fn.nutrient_id=n.id AND n.code=a.old_code;
WITH aliases(old_code) AS (VALUES ('protein'),('calcium'),('iron'),('zinc'),('selenium'),('iodine'),('vitamin_b12'),('vitamin_d'),('fiber'),('fibt'),('omega_3_ala'),('cho'),('polyl'),('vitb6'),('chorl'),('famscis'),('fatrs'),('f18:2cn6'),('f18:3cn3'),('f20:5cn3'),('f22:6cn3'))
DELETE FROM nutrients n USING aliases a WHERE n.code=a.old_code;
-- Enforce one row per canonical code even on installations created before 002.
CREATE UNIQUE INDEX IF NOT EXISTS nutrients_code_unique ON nutrients (code);

-- Kcal is explicitly derived from Fineli's kJ value, never relabelled kJ.
INSERT INTO food_nutrients(food_id,nutrient_id,value,source_name,source_id)
SELECT e.food_id, kcal.id, round(e.value / 4.184, 1), 'Fineli / Finnish Institute for Health and Welfare (derived from ENERC / 4.184)', e.source_id
FROM food_nutrients e JOIN nutrients enerc ON enerc.id=e.nutrient_id AND enerc.code='enerc' JOIN nutrients kcal ON kcal.code='energy_kcal'
ON CONFLICT(food_id,nutrient_id) DO UPDATE SET value=EXCLUDED.value,source_name=EXCLUDED.source_name,source_id=EXCLUDED.source_id;

-- Display names are presentation-only; the raw Fineli name remains intact.
UPDATE foods SET display_name=CASE WHEN name ~ '^[^,]+, GROUND$' THEN initcap(split_part(name,',',2)) || ' ' || initcap(split_part(name,',',1)) ELSE initcap(lower(name)) END WHERE display_name IS NULL OR display_name='';
UPDATE foods SET status='missing_data' WHERE source_name LIKE 'Fineli%' AND NOT EXISTS (SELECT 1 FROM food_nutrients fn WHERE fn.food_id=foods.id);

-- Re-point only unambiguous, case-insensitive duplicate identities; ambiguous legacy rows remain deprecated and historically linked.
CREATE TEMP TABLE nutrition_unambiguous_duplicates AS
SELECT legacy.id legacy_id, fineli.id fineli_id FROM foods legacy JOIN foods fineli ON lower(legacy.name)=lower(fineli.name) AND legacy.id<>fineli.id
WHERE legacy.fineli_food_id IS NULL AND fineli.fineli_food_id IS NOT NULL AND legacy.status<>'deprecated'
  AND (SELECT count(*) FROM foods x WHERE x.fineli_food_id IS NOT NULL AND lower(x.name)=lower(legacy.name))=1;
UPDATE recipe_ingredients ri SET food_id=d.fineli_id FROM nutrition_unambiguous_duplicates d WHERE ri.food_id=d.legacy_id;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='food_entries' AND column_name='food_id') THEN EXECUTE 'UPDATE food_entries e SET food_id=d.fineli_id FROM nutrition_unambiguous_duplicates d WHERE e.food_id=d.legacy_id'; END IF; END $$;
UPDATE foods f SET status='deprecated' FROM nutrition_unambiguous_duplicates d WHERE f.id=d.legacy_id;
DROP TABLE nutrition_unambiguous_duplicates;

-- Corrupt values are made explicitly missing pending raw-CSV reimport; never clamp or guess.
UPDATE foods f SET status='missing_data' WHERE EXISTS (SELECT 1 FROM food_nutrients fn WHERE fn.food_id=f.id AND fn.value<0) OR EXISTS (SELECT 1 FROM food_nutrients fn JOIN nutrients n ON n.id=fn.nutrient_id WHERE fn.food_id=f.id AND n.code IN ('prot','fat','choavl') AND fn.value>100) OR EXISTS (SELECT 1 FROM food_nutrients fn JOIN nutrients n ON n.id=fn.nutrient_id WHERE fn.food_id=f.id AND n.code IN ('prot','fat','choavl') GROUP BY fn.food_id HAVING sum(fn.value)>105);
DELETE FROM food_nutrients fn USING foods f, nutrients n WHERE fn.food_id=f.id AND n.id=fn.nutrient_id AND f.status='missing_data' AND (fn.value<0 OR (n.code IN ('prot','fat','choavl') AND fn.value>100));
ALTER TABLE food_nutrients VALIDATE CONSTRAINT food_nutrients_value_nonnegative;
