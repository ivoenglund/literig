-- Normalized nutrition foundation. Values must carry an explicit source and 100 g basis.
CREATE TABLE IF NOT EXISTS nutrients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  category TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS foods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'raw',
  basis_amount NUMERIC NOT NULL DEFAULT 100,
  basis_unit TEXT NOT NULL DEFAULT 'g',
  source_name TEXT NOT NULL,
  source_id TEXT,
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified','planning','missing_data')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS food_nutrients (
  food_id UUID NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  nutrient_id UUID NOT NULL REFERENCES nutrients(id) ON DELETE CASCADE,
  value NUMERIC NOT NULL,
  source_name TEXT NOT NULL,
  source_id TEXT,
  PRIMARY KEY (food_id, nutrient_id)
);

INSERT INTO nutrients (code, name, unit, category) VALUES
 ('energy_kcal','Energy','kcal','energy'),
 ('protein','Protein','g','macronutrient'),
 ('fiber','Fiber','g','macronutrient'),
 ('calcium','Calcium','mg','mineral'),
 ('iron','Iron','mg','mineral'),
 ('zinc','Zinc','mg','mineral'),
 ('selenium','Selenium','µg','mineral'),
 ('iodine','Iodine','µg','mineral'),
 ('vitamin_b12','Vitamin B12','µg','vitamin'),
 ('vitamin_d','Vitamin D','µg','vitamin'),
 ('omega_3_ala','Omega-3 ALA','g','fatty_acid')
ON CONFLICT (code) DO NOTHING;

-- English names and source IDs confirmed by USDA FoodData Central search.
INSERT INTO foods (name, state, source_name, source_id, status) VALUES
 ('broccoli','raw','USDA FoodData Central','747447','verified'),
 ('spinach','raw','USDA FoodData Central','168462','verified'),
 ('cilantro','raw','USDA FoodData Central','169997','verified'),
 ('orange','raw','USDA FoodData Central','746771','verified'),
 ('blueberries','raw','USDA FoodData Central','2346411','verified'),
 ('lentils','cooked','USDA FoodData Central','172421','verified'),
 ('potato','boiled','USDA FoodData Central','170114','verified')
ON CONFLICT (name) DO UPDATE SET state=EXCLUDED.state, source_name=EXCLUDED.source_name, source_id=EXCLUDED.source_id, status=EXCLUDED.status;

-- These items are deliberately present but marked missing until a precise USDA record is selected.
INSERT INTO foods (name, state, source_name, status) VALUES
 ('tofu','plain','USDA FoodData Central','missing_data'),
 ('rolled oats','dry','USDA FoodData Central','missing_data'),
 ('banana','raw','USDA FoodData Central','missing_data'),
 ('tomato','raw','USDA FoodData Central','missing_data'),
 ('brown rice','cooked','USDA FoodData Central','missing_data')
ON CONFLICT (name) DO NOTHING;
