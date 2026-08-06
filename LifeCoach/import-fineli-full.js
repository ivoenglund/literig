import fs from 'node:fs/promises';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'data', 'fineli');
const SOURCE = 'Fineli / Finnish Institute for Health and Welfare';
const COMPONENTS = [
  ['enerc','Energy','kJ','energy'], ['energy_kcal','Energy','kcal','energy'], ['fat','Fat, total','g','macronutrient'], ['choavl','Carbohydrate, available','g','macronutrient'], ['prot','Protein','g','macronutrient'], ['alc','Alcohol','g','macronutrient'], ['oa','Organic acids, total','g','carbohydrate'], ['sugoh','Sugar alcohols','g','carbohydrate'], ['sugar','Sugars, total','g','carbohydrate'], ['frus','Fructose','g','carbohydrate'], ['gals','Galactose','g','carbohydrate'], ['glus','Glucose','g','carbohydrate'], ['lacs','Lactose','g','carbohydrate'], ['mals','Maltose','g','carbohydrate'], ['sucs','Sucrose','g','carbohydrate'], ['starch','Starch','g','carbohydrate'], ['fibc','Fibre, total','g','macronutrient'], ['fibins','Fibre, insoluble','g','carbohydrate'], ['psacncs','Non-cellulosic polysaccharides, soluble','g','carbohydrate'], ['fol','Folate','µg','vitamin'], ['niaeq','Niacin equivalents','mg','vitamin'], ['nia','Niacin (B3)','mg','vitamin'], ['vitpyrid','Vitamin B6','mg','vitamin'], ['ribf','Riboflavin (B2)','mg','vitamin'], ['thia','Thiamin (B1)','mg','vitamin'], ['vita','Vitamin A (RAE)','µg','vitamin'], ['carotens','Carotenoids','µg','vitamin'], ['vitb12','Vitamin B12','µg','vitamin'], ['vitc','Vitamin C','mg','vitamin'], ['vitd','Vitamin D','µg','vitamin'], ['vite','Vitamin E (alpha-tocopherol)','mg','vitamin'], ['vitk','Vitamin K','µg','vitamin'], ['ca','Calcium','mg','mineral'], ['fe','Iron','mg','mineral'], ['id','Iodine','µg','mineral'], ['k','Potassium','mg','mineral'], ['mg','Magnesium','mg','mineral'], ['na','Sodium','mg','mineral'], ['nacl','Salt','mg','mineral'], ['p','Phosphorus','mg','mineral'], ['se','Selenium','µg','mineral'], ['zn','Zinc','mg','mineral'], ['fafre','Fatty acids, total','g','fat'], ['fapu','Polyunsaturated fat','g','fat'], ['famcis','Monounsaturated fat','g','fat'], ['fasat','Saturated fat','g','fat'], ['fatrn','Trans fat','g','fat'], ['fapun3','Omega-3 fatty acids, total','g','fat'], ['fapun6','Omega-6 fatty acids, total','g','fat'], ['f18d2cn6','Linoleic acid (LA)','mg','fat'], ['f18d3n3','Alpha-linolenic acid (ALA)','mg','fat'], ['f20d5n3','EPA','mg','fat'], ['f22d6n3','DHA','mg','fat'], ['chole','Cholesterol','mg','fat'], ['stert','Sterols, total','mg','fat'], ['trp','Tryptophan','mg','amino acid']
];
export const FINELI_COMPONENTS = new Map(COMPONENTS.map(([code, name, unit, category]) => [code, { code, name, unit, category }]));
let catalogPromise;

const clean = (value) => String(value ?? '').trim();
const number = (value) => Number(clean(value).replace(',', '.'));
const titleCase = (name) => clean(name).toLocaleLowerCase('en-US').replace(/(^|[^\p{L}])(\p{L})/gu, (_match, prefix, letter) => prefix + letter.toLocaleUpperCase('en-US')).replace(/\b(Kj|Mg|Ug|Epa|Dha|La)\b/g, (m) => ({ Kj: 'kJ', Mg: 'mg', Ug: 'µg', Epa: 'EPA', Dha: 'DHA', La: 'LA' })[m]);
export function fineliDisplayName(name) {
  const titled = titleCase(name);
  const ground = titled.match(/^(.+), Ground$/i);
  return ground ? `Ground ${ground[1]}` : titled;
}
async function parse(file) {
  // Fineli's distribution is ISO-8859-1/latin1; never decode it as UTF-8.
  const text = await fs.readFile(path.join(DATA, file), 'latin1');
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const fields = header.split(';');
  return lines.map((line) => Object.fromEntries(fields.map((field, index) => [field, line.split(';')[index] ?? ''])));
}
async function loadCatalog() {
  const [foods, english, swedish, finnish, componentRows, values] = await Promise.all(['food.csv','foodname_EN.csv','foodname_SV.csv','foodname_FI.csv','component.csv','component_value.csv'].map(parse));
  const names = new Map(foods.map((food) => [food.FOODID, {}]));
  for (const row of english) if (names.has(row.FOODID)) names.get(row.FOODID).en = clean(row.FOODNAME);
  for (const row of swedish) if (names.has(row.FOODID)) names.get(row.FOODID).sv = clean(row.FOODNAME);
  for (const row of finnish) if (names.has(row.FOODID)) names.get(row.FOODID).fi = clean(row.FOODNAME);
  const componentCodes = new Set(componentRows.map((row) => clean(row.EUFDNAME).toLowerCase()));
  for (const code of componentCodes) if (!FINELI_COMPONENTS.has(code)) throw new Error(`Fineli component ${code} is missing canonical metadata`);
  const foodsWithoutEnglish = foods.filter((food) => !names.get(food.FOODID)?.en).length;
  const valuesByFoodId = new Map();
  for (const value of values) {
    const code = clean(value.EUFDNAME).toLowerCase(); const amount = number(value.BESTLOC);
    if (!names.has(value.FOODID) || !componentCodes.has(code) || !Number.isFinite(amount)) continue; // blank BESTLOC is missing, never zero.
    const list = valuesByFoodId.get(value.FOODID) || []; list.push({ ...value, code, amount }); valuesByFoodId.set(value.FOODID, list);
  }
  return { foods, names, componentCodes, valuesByFoodId, foodsWithoutEnglish, expected: { foods: foods.length, nutrients: componentCodes.size, nutrientValues: [...valuesByFoodId.values()].reduce((total, rows) => total + rows.length, 0) } };
}
export function getFineliCatalog() { catalogPromise ||= loadCatalog(); return catalogPromise; }
export const kcalFromKj = (kj) => Math.round((Number(kj) / 4.184) * 10) / 10;
export const fineliFoodStatus = (nutrientRows) => nutrientRows.length ? 'verified' : 'missing_data';

export async function getFineliCatalogStatus(pool) {
  const catalog = await getFineliCatalog(); const codes = [...catalog.componentCodes];
  const result = await pool.query(`SELECT (SELECT count(*)::int FROM foods WHERE source_name LIKE 'Fineli%' AND fineli_food_id IS NOT NULL) foods, (SELECT count(*)::int FROM nutrients WHERE code = ANY($1::text[])) nutrients, (SELECT count(*)::int FROM food_nutrients fn JOIN foods f ON f.id=fn.food_id JOIN nutrients n ON n.id=fn.nutrient_id WHERE f.source_name LIKE 'Fineli%' AND f.fineli_food_id IS NOT NULL AND n.code=ANY($1::text[])) nutrient_values`, [codes]);
  const actual = result.rows[0]; return { expected: catalog.expected, actual: { foods: actual.foods, nutrients: actual.nutrients, nutrientValues: actual.nutrient_values }, complete: Number(actual.foods) === catalog.expected.foods && Number(actual.nutrients) === catalog.expected.nutrients && Number(actual.nutrient_values) === catalog.expected.nutrientValues, foodsWithoutEnglish: catalog.foodsWithoutEnglish };
}
export async function importFullFineli(pool, { offset = 0, limit = 25 } = {}) {
  const catalog = await getFineliCatalog(); const safeOffset = Math.max(0, Math.floor(Number(offset) || 0)); const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 25))); const selectedFoods = catalog.foods.slice(safeOffset, safeOffset + safeLimit);
  if (!selectedFoods.length) return { offset: safeOffset, nextOffset: safeOffset, complete: true, importedFoods: 0, importedNutrientValues: 0, expected: catalog.expected };
  const client = await pool.connect();
  try { await client.query('BEGIN');
    await client.query(`INSERT INTO nutrients (code,name,unit,category) SELECT x.code,x.name,x.unit,x.category FROM jsonb_to_recordset($1::jsonb) x(code text,name text,unit text,category text) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,unit=EXCLUDED.unit,category=EXCLUDED.category`, [JSON.stringify([...FINELI_COMPONENTS.values()])]);
    for (const food of selectedFoods) {
      const names = catalog.names.get(food.FOODID) || {}; const sourceName = names.en || names.sv || names.fi;
      if (!sourceName) throw new Error(`Fineli food ${food.FOODID} has no name in any supplied language`);
      const rows = catalog.valuesByFoodId.get(food.FOODID) || []; const status = fineliFoodStatus(rows);
      await client.query(`INSERT INTO foods(fineli_food_id,name,display_name,name_sv,name_fi,state,edible_portion_percent,basis_amount,basis_unit,source_name,source_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,100,'g',$8,'Fineli',$9) ON CONFLICT(fineli_food_id) DO UPDATE SET name=EXCLUDED.name,display_name=EXCLUDED.display_name,name_sv=EXCLUDED.name_sv,name_fi=EXCLUDED.name_fi,state=EXCLUDED.state,edible_portion_percent=EXCLUDED.edible_portion_percent,basis_amount=100,basis_unit='g',source_name=EXCLUDED.source_name,source_id='Fineli',status=EXCLUDED.status`, [Number(food.FOODID), sourceName, fineliDisplayName(sourceName), names.sv || null, names.fi || null, food.PROCESS || 'unknown', Number.isFinite(number(food.EDPORT)) ? number(food.EDPORT) : null, SOURCE, status]);
      if (rows.length) await client.query(`INSERT INTO food_nutrients(food_id,nutrient_id,value,source_name,source_id) SELECT f.id,n.id,x.value,$3,f.fineli_food_id::text FROM jsonb_to_recordset($1::jsonb) x(code text,value numeric) JOIN foods f ON f.fineli_food_id=$2 JOIN nutrients n ON n.code=x.code ON CONFLICT(food_id,nutrient_id) DO UPDATE SET value=EXCLUDED.value,source_name=EXCLUDED.source_name,source_id=EXCLUDED.source_id`, [JSON.stringify(rows.map((r) => ({ code: r.code, value: r.amount }))), Number(food.FOODID), SOURCE]);
      const enerc = rows.find((row) => row.code === 'enerc'); if (enerc) await client.query(`INSERT INTO food_nutrients(food_id,nutrient_id,value,source_name,source_id) SELECT f.id,n.id,$2,$3,f.fineli_food_id::text FROM foods f JOIN nutrients n ON n.code='energy_kcal' WHERE f.fineli_food_id=$1 ON CONFLICT(food_id,nutrient_id) DO UPDATE SET value=EXCLUDED.value,source_name=EXCLUDED.source_name,source_id=EXCLUDED.source_id`, [Number(food.FOODID), kcalFromKj(enerc.amount), `${SOURCE} (derived from ENERC / 4.184)`]);
    }
    const nutrientRows = selectedFoods.reduce((total, food) => total + (catalog.valuesByFoodId.get(food.FOODID) || []).length, 0); const nextOffset = safeOffset + selectedFoods.length;
    await client.query(`INSERT INTO nutrition_catalog_import_runs(source_name,source_version,requested_offset,requested_limit,expected_foods,expected_nutrients,expected_nutrient_values,imported_foods,imported_nutrient_values,completed) VALUES('Fineli','local-csv',$1,$2,$3,$4,$5,$6,$7,$8)`, [safeOffset,safeLimit,catalog.expected.foods,catalog.expected.nutrients,catalog.expected.nutrientValues,selectedFoods.length,nutrientRows,nextOffset >= catalog.expected.foods]);
    await client.query('COMMIT'); return { offset: safeOffset, nextOffset, complete: nextOffset >= catalog.expected.foods, importedFoods: selectedFoods.length, importedNutrientValues: nutrientRows, expected: catalog.expected };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
