import express from 'express';
import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { importFullFineli } from './import-fineli-full.js';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// Fineli component codes. ENERC is published in kJ and converted explicitly.
const DISPLAY_NUTRIENTS = [
  ['enerc', 'Energy', 'kcal', 1 / 4.184], ['prot', 'Protein', 'g', 1], ['fibc', 'Fiber', 'g', 1],
  ['ca', 'Calcium', 'mg', 1], ['fe', 'Iron', 'mg', 1], ['vitb12', 'Vitamin B12', 'µg', 1],
  ['vitd', 'Vitamin D', 'µg', 1], ['id', 'Iodine', 'µg', 1], ['zn', 'Zinc', 'mg', 1],
  ['se', 'Selenium', 'µg', 1], ['f18:3cn3', 'Omega-3 ALA', 'mg', 1]
];

async function calculateSnapshotNutrition(client, snapshot) {
  const items = Array.isArray(snapshot) ? snapshot : [];
  const result = await client.query(`
    WITH items AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(name text, amount numeric, unit text, food_id uuid)),
    gram_items AS (SELECT * FROM items WHERE unit='g' AND amount > 0),
    linked AS (SELECT i.*, f.id AS matched_food_id, f.basis_amount FROM gram_items i LEFT JOIN foods f ON f.id=i.food_id AND f.basis_unit='g' AND f.status='verified'),
    values_by_code AS (SELECT n.code, SUM(fn.value * l.amount / l.basis_amount) AS total FROM linked l JOIN food_nutrients fn ON fn.food_id=l.matched_food_id JOIN nutrients n ON n.id=fn.nutrient_id WHERE n.code = ANY($2::text[]) GROUP BY n.code)
    SELECT (SELECT count(*)::int FROM items) AS ingredient_count,
      (SELECT count(*)::int FROM gram_items) AS gram_ingredient_count,
      (SELECT count(*)::int FROM linked WHERE matched_food_id IS NOT NULL) AS linked_gram_ingredient_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',name,'amount',amount,'unit',unit,'reason',CASE WHEN unit <> 'g' THEN 'amount is not an explicit gram weight' WHEN amount <= 0 THEN 'amount is not positive' WHEN food_id IS NULL THEN 'no verified Fineli food link' ELSE 'linked food is unavailable' END)) FROM items WHERE unit <> 'g' OR amount <= 0 OR food_id IS NULL), '[]'::jsonb) AS unresolved,
      COALESCE((SELECT jsonb_object_agg(code, total) FROM values_by_code), '{}'::jsonb) AS totals
  `, [JSON.stringify(items), DISPLAY_NUTRIENTS.map(([code]) => code)]);
  const row = result.rows[0], raw = row.totals || {};
  return { nutrients: DISPLAY_NUTRIENTS.map(([code, name, unit, factor]) => ({ code, name, unit, value: raw[code] == null ? null : Number(raw[code]) * factor })), coverage: { ingredients: Number(row.ingredient_count), gram_ingredients: Number(row.gram_ingredient_count), linked_gram_ingredients: Number(row.linked_gram_ingredient_count), unresolved: row.unresolved } };
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://literig.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.'));

app.get('/api/health', async (_req, res) => {
  if (!pool) return res.status(503).json({ ok: false, database: 'not configured' });
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (error) {
    console.error('Database health check failed:', error.message);
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.get('/api/nutrition-catalog-status', async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query(`SELECT count(*) FILTER (WHERE source_name LIKE 'Fineli%')::int AS fineli_foods, (SELECT count(*)::int FROM nutrients WHERE category='fineli') AS nutrients, (SELECT count(*)::int FROM food_nutrients fn JOIN foods f ON f.id=fn.food_id WHERE f.source_name LIKE 'Fineli%') AS nutrient_values FROM foods`);
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ error: 'Could not read catalog status' }); }
});

function importTokenMatches(requestToken) {
  const configuredToken = process.env.FINELI_IMPORT_TOKEN;
  if (!configuredToken || typeof requestToken !== 'string') return false;
  const expected = Buffer.from(configuredToken);
  const received = Buffer.from(requestToken);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

app.post('/api/fineli-import-batch', async (req, res) => {
  // The import operation mutates the catalog, so it is deliberately operator-only.
  if (!importTokenMatches(req.get('x-fineli-import-token'))) return res.sendStatus(404);
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const offset = Math.max(0, Number(req.body?.offset || 0));
  try { res.json(await importFullFineli(pool, { offset, limit: 25 })); }
  catch (error) { console.error('Fineli batch failed:', error.message); res.status(500).json({ error: 'Fineli batch failed' }); }
});

app.post('/api/bootstrap', async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id');
    await pool.query('INSERT INTO nutrition_profiles (user_id) VALUES ($1)', [result.rows[0].id]);
    res.status(201).json({ user_id: result.rows[0].id });
  } catch (error) {
    console.error('Bootstrap failed:', error.message);
    res.status(500).json({ error: 'Could not create user' });
  }
});

app.get('/api/foods', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json({ foods: [], note: 'Search needs at least two characters; no approximate food is selected automatically.' });
  try {
    const result = await pool.query(`
      SELECT id, name, name_sv, name_fi, state, fineli_food_id, source_name
      FROM foods
      WHERE status='verified' AND basis_amount=100 AND basis_unit='g' AND fineli_food_id IS NOT NULL
        AND (name ILIKE $1 || '%' OR name_sv ILIKE $1 || '%' OR name_fi ILIKE $1 || '%')
        AND name !~* '(wok|soup|hamburger|casserole|gravy|dessert|ice cream|frankfurter|noodle)'
      ORDER BY CASE WHEN lower(name)=lower($1) THEN 0 ELSE 1 END, name
      LIMIT 20`, [query]);
    res.json({ foods: result.rows, note: 'Choose an exact Fineli record and preparation state. Results are not automatically matched.' });
  } catch (error) {
    console.error('Food search failed:', error.message);
    res.status(500).json({ error: 'Could not search foods' });
  }
});

app.get('/api/totals', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
    const entries = await pool.query(`SELECT re.ingredients_snapshot FROM recipe_entries re JOIN food_entries fe ON fe.id=re.entry_id WHERE fe.user_id=$1 AND fe.eaten_at::date=$2`, [userId, targetDate]);
    const sums = Object.fromEntries(DISPLAY_NUTRIENTS.map(([code]) => [code, 0]));
    const available = Object.fromEntries(DISPLAY_NUTRIENTS.map(([code]) => [code, false]));
    const unresolved = []; let gramIngredients = 0, linkedGramIngredients = 0;
    for (const entry of entries.rows) {
      const calculated = await calculateSnapshotNutrition(pool, entry.ingredients_snapshot);
      gramIngredients += calculated.coverage.gram_ingredients;
      linkedGramIngredients += calculated.coverage.linked_gram_ingredients;
      unresolved.push(...calculated.coverage.unresolved);
      for (const nutrient of calculated.nutrients) if (nutrient.value != null) { sums[nutrient.code] += nutrient.value; available[nutrient.code] = true; }
    }
    const nutrients = DISPLAY_NUTRIENTS.map(([code, name, unit]) => ({ code, name, unit, value: available[code] ? sums[code] : null,
      status: !entries.rows.length ? 'no_recipe_data' : (!available[code] ? 'missing_source_coverage' : (gramIngredients === linkedGramIngredients ? 'covered' : 'partial_coverage')) }));
    res.json({ date: targetDate, recipe_entries: entries.rows.length, nutrients, coverage: { gram_ingredients: gramIngredients, linked_gram_ingredients: linkedGramIngredients, unresolved }, basis: 'Fineli food_nutrients per 100 g; immutable recipe snapshots only; no supplements' });
  } catch (error) {
    console.error('Totals query failed:', error.message);
    res.status(500).json({ error: 'Could not load totals' });
  }
});

app.get('/api/health-events', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const result = await pool.query(`SELECT id, event_type, occurred_at, value_numeric, unit, note FROM health_events WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 100`, [userId]);
    res.json({ events: result.rows });
  } catch (error) {
    console.error('Health event query failed:', error.message);
    res.status(500).json({ error: 'Could not load health events' });
  }
});

app.post('/api/health-events', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, event_type: eventType, occurred_at: occurredAt, value_numeric: valueNumeric = null, unit = null, note = null } = req.body;
  const allowed = ['exercise', 'sleep', 'weight', 'measurement', 'note'];
  if (!userId || !allowed.includes(eventType)) return res.status(400).json({ error: 'user_id and valid event_type are required' });
  try {
    const result = await pool.query(`INSERT INTO health_events (user_id, event_type, occurred_at, value_numeric, unit, note) VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6) RETURNING id, event_type, occurred_at, value_numeric, unit, note`, [userId, eventType, occurredAt || null, valueNumeric, unit, note]);
    res.status(201).json({ event: result.rows[0] });
  } catch (error) {
    console.error('Health event insert failed:', error.message);
    res.status(500).json({ error: 'Could not save health event' });
  }
});

app.get('/api/recipes', async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const result = await pool.query(`SELECT r.id, r.name, r.description, r.instructions, r.servings, COALESCE(json_agg(json_build_object('name',ri.ingredient_name,'amount',ri.amount,'unit',ri.unit,'food_id',ri.food_id) ORDER BY ri.sort_order) FILTER (WHERE ri.id IS NOT NULL), '[]') AS ingredients FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id=r.id GROUP BY r.id ORDER BY r.name`);
  res.json({ recipes: result.rows });
});

app.put('/api/recipes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { instructions } = req.body;
  if (typeof instructions !== 'string') return res.status(400).json({ error: 'instructions is required' });
  const result = await pool.query('UPDATE recipes SET instructions=$1 WHERE id=$2 RETURNING id, name, instructions', [instructions.trim(), req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Recipe not found' });
  res.json({ recipe: result.rows[0] });
});

app.post('/api/recipes/:id/log', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, eaten_at: eatenAt, note = null } = req.body;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const recipe = await pool.query('SELECT name FROM recipes WHERE id=$1', [req.params.id]);
    if (!recipe.rows[0]) return res.status(404).json({ error: 'Recipe not found' });
    const ingredients = await pool.query(`SELECT ingredient_name AS name, amount, unit, food_id FROM recipe_ingredients WHERE recipe_id=$1 ORDER BY sort_order`, [req.params.id]);
    const calculation = await calculateSnapshotNutrition(pool, ingredients.rows);
    const result = await pool.query(`INSERT INTO food_entries (user_id, description, eaten_at, status, source, quantity_note, nutrition_estimate) VALUES ($1,$2,COALESCE($3,now()),'confirmed','recipe',$4,$5) RETURNING id,eaten_at,description,status,source,quantity_note,nutrition_estimate`, [userId, recipe.rows[0].name, eatenAt || null, note, JSON.stringify({ source: 'normalized_foods', coverage: calculation.coverage })]);
    await pool.query(`INSERT INTO recipe_entries (entry_id, recipe_id, ingredients_snapshot) VALUES ($1,$2,$3)`, [result.rows[0].id, req.params.id, JSON.stringify(ingredients.rows)]);
    res.status(201).json({ entry: { ...result.rows[0], recipe_id: req.params.id, ingredients: ingredients.rows, nutrition: calculation } });
  } catch (error) { res.status(500).json({ error: 'Could not log recipe' }); }
});

app.get('/api/summary', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS registered_entries,
              COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed_entries,
              COUNT(*) FILTER (WHERE status = 'estimated')::int AS estimated_entries,
              COUNT(*) FILTER (WHERE status = 'planned')::int AS planned_entries
       FROM food_entries WHERE user_id = $1`, [userId]
    );
    res.json({ summary: result.rows[0], nutrition_status: 'waiting_for_quantities' });
  } catch (error) {
    console.error('Summary query failed:', error.message);
    res.status(500).json({ error: 'Could not load summary' });
  }
});

app.get('/api/entries', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  const date = req.query.date;
  const params = date ? [userId, date] : [userId];
  const dateClause = date ? ' AND eaten_at::date = $2' : '';
  try {
    const result = await pool.query(`SELECT fe.id, fe.eaten_at, fe.description, fe.status, fe.source, fe.quantity_note, fe.nutrition_estimate, re.recipe_id, re.ingredients_snapshot AS ingredients FROM food_entries fe LEFT JOIN recipe_entries re ON re.entry_id=fe.id WHERE fe.user_id = $1${dateClause} ORDER BY fe.eaten_at DESC LIMIT 100`, params);
    res.json({ entries: result.rows, date: date || null });
  } catch (error) {
    console.error('Entry query failed:', error.message);
    res.status(500).json({ error: 'Could not load entries' });
  }
});

app.put('/api/entries/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, description, quantity_note: quantityNote = null } = req.body;
  if (!userId || !description) return res.status(400).json({ error: 'user_id and description are required' });
  try {
    const result = await pool.query(`UPDATE food_entries SET description=$1, quantity_note=$2 WHERE id=$3 AND user_id=$4 RETURNING id, eaten_at, description, status, quantity_note, nutrition_estimate`, [description, quantityNote, req.params.id, userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Entry not found' });
    res.json({ entry: result.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Could not update entry' }); }
});

app.delete('/api/recipe-entries/:entryId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const result = await pool.query('DELETE FROM food_entries WHERE id=$1 AND user_id=$2 AND source=\'recipe\' RETURNING id', [req.params.entryId, userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Recipe entry not found' });
    res.status(204).end();
  } catch (error) { console.error('Recipe entry delete failed:', error.message); res.status(500).json({ error: 'Could not delete recipe entry' }); }
});

app.put('/api/recipe-entries/:entryId', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, ingredients, update_standard = false } = req.body;
  if (!userId || !Array.isArray(ingredients)) return res.status(400).json({ error: 'user_id and ingredients are required' });
  try {
    const owner = await pool.query('SELECT re.recipe_id FROM recipe_entries re JOIN food_entries fe ON fe.id=re.entry_id WHERE re.entry_id=$1 AND fe.user_id=$2', [req.params.entryId, userId]);
    if (!owner.rows[0]) return res.status(404).json({ error: 'Recipe entry not found' });
    const recipeId = owner.rows[0].recipe_id;
    if (update_standard) {
      await pool.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [recipeId]);
      for (const [i, item] of ingredients.entries()) await pool.query('INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount, unit, food_id, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [recipeId, item.name, Number(item.amount), item.unit || 'g', item.food_id || null, i]);
    }
    const calculation = await calculateSnapshotNutrition(pool, ingredients);
    await pool.query('UPDATE recipe_entries SET ingredients_snapshot=$1, updated_at=now() WHERE entry_id=$2', [JSON.stringify(ingredients), req.params.entryId]);
    await pool.query('UPDATE food_entries SET nutrition_estimate=$1, quantity_note=$2 WHERE id=$3 AND user_id=$4', [JSON.stringify({ source: 'normalized_foods', coverage: calculation.coverage }), 'Ingredienser redigerade för denna dag', req.params.entryId, userId]);
    res.json({ entry_id: req.params.entryId, ingredients, nutrition: calculation, standard_updated: update_standard });
  } catch (error) { console.error('Recipe entry update failed:', error.message); res.status(500).json({ error: 'Could not update recipe entry' }); }
});

app.post('/api/entries', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, description, eaten_at: eatenAt, status = 'confirmed', source = 'text', quantity_note: quantityNote = null, nutrition_estimate: nutritionEstimate = null } = req.body;
  if (!userId || !description) return res.status(400).json({ error: 'user_id and description are required' });
  try {
    const result = await pool.query(
      `INSERT INTO food_entries (user_id, description, eaten_at, status, source, quantity_note, nutrition_estimate)
       VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6, $7)
       RETURNING id, eaten_at, description, status, source, quantity_note, nutrition_estimate`,
      [userId, description, eatenAt || null, status, source, quantityNote, nutritionEstimate]
    );
    res.status(201).json({ entry: result.rows[0] });
  } catch (error) {
    console.error('Entry insert failed:', error.message);
    res.status(500).json({ error: 'Could not save entry' });
  }
});

async function applyNutritionMigrations() {
  if (!pool) return;
  for (const filename of ['002_normalized_nutrition.sql', '003_import_fineli_verified_foods.sql', '004_english_recipes.sql', '005_link_recipe_ingredients_fineli.sql', '006_recipe_snapshot_nutrition.sql', '007_restore_verified_spinach.sql']) {
    const sql = await fs.readFile(path.join(process.cwd(), 'migrations', filename), 'utf8');
    await pool.query(sql);
  }
  console.log('Fineli nutrition migrations applied');
  // Full Fineli import is intentionally not run at API startup. It must run in resumable batches.
}

applyNutritionMigrations()
  .then(() => app.listen(port, () => console.log(`LITERIG Life Coach API listening on port ${port}`)))
  .catch((error) => { console.error('Nutrition migration failed:', error.message); process.exit(1); });
