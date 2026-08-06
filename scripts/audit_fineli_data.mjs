import assert from 'node:assert/strict';
import { FINELI_COMPONENTS, getFineliCatalog } from '../import-fineli-full.js';

const catalog = await getFineliCatalog();
const fail = [];
const rawCodes = [...catalog.componentCodes].sort();
const canonicalCodes = [...FINELI_COMPONENTS.keys()].filter((code) => code !== 'energy_kcal').sort();
if (JSON.stringify(rawCodes) !== JSON.stringify(canonicalCodes)) fail.push('component.csv codes do not exactly match the canonical Fineli map');
if (catalog.expected.foods !== 4238) fail.push(`expected 4,238 foods, found ${catalog.expected.foods}`);
if (catalog.expected.nutrientValues !== 229642) fail.push(`expected 229,642 nutrient values, found ${catalog.expected.nutrientValues}`);
if (![...catalog.names.values()].some((name) => /[äö]/i.test(`${name.sv || ''}${name.fi || ''}`))) fail.push('latin1 decoding did not preserve Swedish/Finnish ä/ö');
for (const [foodId, values] of catalog.valuesByFoodId) for (const value of values) if (!Number.isFinite(value.amount) || value.amount < 0) fail.push(`invalid raw Fineli value for food ${foodId}`);
const noValues = catalog.foods.filter((food) => !(catalog.valuesByFoodId.get(food.FOODID) || []).length);
if (!noValues.length) fail.push('expected Fineli foods without values to exercise missing_data handling');

if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM (SELECT code FROM nutrients GROUP BY code HAVING count(*)>1) x) duplicate_codes,
        (SELECT count(*) FROM nutrients WHERE name=code) code_names,
        (SELECT count(*) FROM nutrients n JOIN jsonb_to_recordset($1::jsonb) x(code text,name text,unit text,category text) USING(code) WHERE n.name<>x.name OR n.unit<>x.unit OR n.category<>x.category) wrong_metadata,
        (SELECT count(*) FROM foods f WHERE f.status='verified' AND NOT EXISTS (SELECT 1 FROM food_nutrients fn WHERE fn.food_id=f.id)) verified_without_values,
        (SELECT count(*) FROM foods WHERE source_name LIKE 'Fineli%' AND status='verified' AND fineli_food_id IS NULL) unkeyed_fineli_foods,
        (SELECT count(*) FROM food_nutrients WHERE value<0) negative_values,
        (SELECT count(*) FROM food_nutrients fn JOIN nutrients n ON n.id=fn.nutrient_id WHERE n.code IN ('prot','fat','choavl') AND fn.value>100) impossible_macros,
        (SELECT count(*) FROM (SELECT fn.food_id FROM food_nutrients fn JOIN nutrients n ON n.id=fn.nutrient_id WHERE n.code IN ('prot','fat','choavl') GROUP BY fn.food_id HAVING sum(fn.value)>105) x) impossible_macro_sums,
        (SELECT count(*) FROM recipe_ingredients ri LEFT JOIN foods f ON f.id=ri.food_id WHERE ri.food_id IS NOT NULL AND f.id IS NULL) orphan_recipe_references,
        (SELECT count(*) FROM food_entries e LEFT JOIN foods f ON f.id=NULLIF(to_jsonb(e)->>'food_id','')::uuid WHERE to_jsonb(e) ? 'food_id' AND NULLIF(to_jsonb(e)->>'food_id','') IS NOT NULL AND f.id IS NULL) orphan_entry_references
    `, [JSON.stringify([...FINELI_COMPONENTS.values()])]);
    for (const [key, value] of Object.entries(rows[0])) if (Number(value) !== 0) fail.push(`${key}: ${value}`);
  } finally { await pool.end(); }
}
assert.equal(fail.length, 0, `Fineli audit failed:\n${fail.join('\n')}`);
console.log(JSON.stringify({ expected: catalog.expected, foodsWithoutNutrientValues: noValues.length, foodsWithoutEnglish: catalog.foodsWithoutEnglish, databaseAudited: Boolean(process.env.DATABASE_URL), defects: 0 }));
