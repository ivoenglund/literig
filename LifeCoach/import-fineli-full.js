import fs from 'node:fs/promises';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'data', 'fineli');
let catalogPromise;

const clean = (value) => String(value || '').trim();
const number = (value) => Number(String(value).replace(',', '.'));

async function parse(file) {
  const text = await fs.readFile(path.join(DATA, file), 'latin1');
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const fields = header.split(';');
  return lines.map((line) => Object.fromEntries(fields.map((field, index) => [field, line.split(';')[index] ?? ''])));
}

async function loadCatalog() {
  const [foods, english, swedish, finnish, components, values] = await Promise.all([
    parse('food.csv'), parse('foodname_EN.csv'), parse('foodname_SV.csv'), parse('foodname_FI.csv'), parse('component.csv'), parse('component_value.csv')
  ]);
  const names = new Map();
  for (const row of english) names.set(row.FOODID, { en: clean(row.FOODNAME) });
  for (const row of swedish) if (names.has(row.FOODID)) names.get(row.FOODID).sv = clean(row.FOODNAME);
  for (const row of finnish) if (names.has(row.FOODID)) names.get(row.FOODID).fi = clean(row.FOODNAME);

  const componentUnits = new Map(components.map((row) => [row.EUFDNAME, row.COMPUNIT]));
  const selectedFoods = foods.filter((food) => names.get(food.FOODID)?.en);
  const valuesByFoodId = new Map();
  for (const value of values) {
    if (!names.has(value.FOODID) || !componentUnits.has(value.EUFDNAME) || !Number.isFinite(number(value.BESTLOC))) continue;
    const list = valuesByFoodId.get(value.FOODID) || [];
    list.push(value);
    valuesByFoodId.set(value.FOODID, list);
  }

  return {
    foods: selectedFoods,
    names,
    componentUnits,
    valuesByFoodId,
    expected: {
      foods: selectedFoods.length,
      nutrients: componentUnits.size,
      nutrientValues: [...valuesByFoodId.values()].reduce((total, valuesForFood) => total + valuesForFood.length, 0)
    }
  };
}

export function getFineliCatalog() {
  catalogPromise ||= loadCatalog();
  return catalogPromise;
}

export async function getFineliCatalogStatus(pool) {
  const catalog = await getFineliCatalog();
  const currentCodes = [...catalog.componentUnits.keys()].map((code) => code.toLowerCase());
  const result = await pool.query(`
    WITH fineli_foods AS (
      SELECT DISTINCT ON (fineli_food_id) id, fineli_food_id
      FROM foods
      WHERE source_name LIKE 'Fineli%'
      ORDER BY fineli_food_id, id
    )
    SELECT
      (SELECT count(*)::int FROM fineli_foods) AS foods,
      (SELECT count(*)::int FROM nutrients WHERE code = ANY($1::text[])) AS nutrients,
      (SELECT count(*)::int
       FROM food_nutrients fn
       JOIN fineli_foods f ON f.id=fn.food_id
       JOIN nutrients n ON n.id=fn.nutrient_id
       WHERE n.code = ANY($1::text[])) AS nutrient_values
  `, [currentCodes]);
  const actual = result.rows[0];
  return {
    expected: catalog.expected,
    actual: { foods: actual.foods, nutrients: actual.nutrients, nutrientValues: actual.nutrient_values },
    complete: Number(actual.foods) === catalog.expected.foods && Number(actual.nutrients) === catalog.expected.nutrients && Number(actual.nutrient_values) === catalog.expected.nutrientValues
  };
}

export async function importFullFineli(pool, { offset = 0, limit = 25 } = {}) {
  const catalog = await getFineliCatalog();
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const safeLimit = Math.min(25, Math.max(1, Math.floor(Number(limit) || 25)));
  const selectedFoods = catalog.foods.slice(safeOffset, safeOffset + safeLimit);
  if (!selectedFoods.length) return { offset: safeOffset, nextOffset: safeOffset, complete: true, importedFoods: 0, importedNutrientValues: 0, expected: catalog.expected };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const foodValues = [], foodArgs = [];
    for (const food of selectedFoods) {
      const name = catalog.names.get(food.FOODID);
      const index = foodArgs.length;
      foodArgs.push(Number(food.FOODID), name.en, name.sv || null, name.fi || null, food.PROCESS || 'unknown');
      foodValues.push(`($${index + 1},$${index + 2},$${index + 3},$${index + 4},$${index + 5},100,'g','Fineli / Finnish Institute for Health and Welfare','Fineli','verified')`);
    }
    await client.query(`
      INSERT INTO foods (fineli_food_id,name,name_sv,name_fi,state,basis_amount,basis_unit,source_name,source_id,status)
      VALUES ${foodValues.join(',')}
      ON CONFLICT (fineli_food_id) DO UPDATE SET
        name=EXCLUDED.name, name_sv=EXCLUDED.name_sv, name_fi=EXCLUDED.name_fi,
        state=EXCLUDED.state, basis_amount=EXCLUDED.basis_amount, basis_unit=EXCLUDED.basis_unit,
        source_name=EXCLUDED.source_name, source_id=EXCLUDED.source_id, status='verified'
    `, foodArgs);

    for (const [code, unit] of catalog.componentUnits) {
      await client.query(`INSERT INTO nutrients (code,name,unit,category) VALUES ($1,$1,$2,'fineli') ON CONFLICT (code) DO UPDATE SET unit=EXCLUDED.unit, category='fineli'`, [code.toLowerCase(), unit]);
    }

    const nutrientRows = selectedFoods.flatMap((food) => catalog.valuesByFoodId.get(food.FOODID) || []);
    for (let start = 0; start < nutrientRows.length; start += 500) {
      const batch = nutrientRows.slice(start, start + 500);
      const values = [], args = [];
      for (const nutrient of batch) {
        const index = args.length;
        args.push(Number(nutrient.FOODID), nutrient.EUFDNAME.toLowerCase(), number(nutrient.BESTLOC));
        values.push(`($${index + 1},$${index + 2},$${index + 3})`);
      }
      await client.query(`
        INSERT INTO food_nutrients (food_id,nutrient_id,value,source_name,source_id)
        SELECT f.id,n.id,x.value::numeric,'Fineli / Finnish Institute for Health and Welfare',f.fineli_food_id::text
        FROM (VALUES ${values.join(',')}) AS x(fineli_food_id,code,value)
        JOIN foods f ON f.fineli_food_id=x.fineli_food_id::integer
        JOIN nutrients n ON n.code=x.code
        ON CONFLICT (food_id,nutrient_id) DO UPDATE SET value=EXCLUDED.value, source_name=EXCLUDED.source_name, source_id=EXCLUDED.source_id
      `, args);
    }

    const nextOffset = safeOffset + selectedFoods.length;
    const run = await client.query(`
      INSERT INTO nutrition_catalog_import_runs
        (source_name, source_version, requested_offset, requested_limit, expected_foods, expected_nutrients, expected_nutrient_values, imported_foods, imported_nutrient_values, completed)
      VALUES ('Fineli','local-csv', $1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, created_at
    `, [safeOffset, safeLimit, catalog.expected.foods, catalog.expected.nutrients, catalog.expected.nutrientValues, selectedFoods.length, nutrientRows.length, nextOffset >= catalog.expected.foods]);
    await client.query('COMMIT');
    return { run: run.rows[0], offset: safeOffset, nextOffset, complete: nextOffset >= catalog.expected.foods, importedFoods: selectedFoods.length, importedNutrientValues: nutrientRows.length, expected: catalog.expected };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
