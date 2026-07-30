import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://literig.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

app.get('/api/foods', async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const result = await pool.query('SELECT id, name, kcal_per_100g, protein_g_per_100g, fiber_g_per_100g, calcium_mg_per_100g, iron_mg_per_100g, source_note FROM food_catalog ORDER BY name');
  res.json({ foods: result.rows });
});

app.post('/api/estimate', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { food_id: foodId, grams } = req.body;
  const amount = Number(grams);
  if (!foodId || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'food_id and positive grams are required' });
  const result = await pool.query('SELECT * FROM food_catalog WHERE id = $1', [foodId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Food not found' });
  const f = result.rows[0];
  const factor = amount / 100;
  res.json({ basis: 'standardvärde per 100 g', grams: amount, food: f.name, estimated: { kcal: Number(f.kcal_per_100g) * factor, protein_g: Number(f.protein_g_per_100g) * factor, fiber_g: Number(f.fiber_g_per_100g) * factor, calcium_mg: Number(f.calcium_mg_per_100g) * factor, iron_mg: Number(f.iron_mg_per_100g) * factor }, status: 'estimated', note: f.source_note });
});

app.get('/api/totals', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE nutrition_estimate IS NOT NULL)::int AS estimated_entries,
        COALESCE(SUM((nutrition_estimate->>'kcal')::numeric), 0) AS kcal,
        COALESCE(SUM((nutrition_estimate->>'protein_g')::numeric), 0) AS protein_g,
        COALESCE(SUM((nutrition_estimate->>'fiber_g')::numeric), 0) AS fiber_g,
        COALESCE(SUM((nutrition_estimate->>'calcium_mg')::numeric), 0) AS calcium_mg,
        COALESCE(SUM((nutrition_estimate->>'iron_mg')::numeric), 0) AS iron_mg
      FROM food_entries WHERE user_id = $1 AND eaten_at::date = $2`, [userId, targetDate]);
    const averages = await pool.query(`SELECT ROUND(AVG(day_kcal), 1) AS kcal, ROUND(AVG(day_protein), 1) AS protein_g, ROUND(AVG(day_fiber), 1) AS fiber_g FROM (SELECT eaten_at::date, COALESCE(SUM((nutrition_estimate->>'kcal')::numeric),0) day_kcal, COALESCE(SUM((nutrition_estimate->>'protein_g')::numeric),0) day_protein, COALESCE(SUM((nutrition_estimate->>'fiber_g')::numeric),0) day_fiber FROM food_entries WHERE user_id=$1 AND eaten_at::date BETWEEN ($2::date - INTERVAL '29 days') AND $2::date GROUP BY eaten_at::date) d`, [userId, targetDate]);
    res.json({ date: targetDate, totals: result.rows[0], averages_30_days: averages.rows[0], basis: 'registrerade uppskattningar' });
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
  const result = await pool.query(`SELECT r.id, r.name, r.description, r.instructions, r.servings, COALESCE(json_agg(json_build_object('name',ri.ingredient_name,'amount',ri.amount,'unit',ri.unit) ORDER BY ri.sort_order) FILTER (WHERE ri.id IS NOT NULL), '[]') AS ingredients FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id=r.id GROUP BY r.id ORDER BY r.name`);
  res.json({ recipes: result.rows });
});

app.post('/api/recipes/:id/log', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, eaten_at: eatenAt, note = null } = req.body;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const recipe = await pool.query('SELECT name FROM recipes WHERE id=$1', [req.params.id]);
    if (!recipe.rows[0]) return res.status(404).json({ error: 'Recipe not found' });
    const ingredients = await pool.query(`SELECT ingredient_name AS name, amount, unit FROM recipe_ingredients WHERE recipe_id=$1 ORDER BY sort_order`, [req.params.id]);
    const result = await pool.query(`INSERT INTO food_entries (user_id, description, eaten_at, status, source, quantity_note) VALUES ($1,$2,COALESCE($3,now()),'confirmed','recipe',$4) RETURNING id,eaten_at,description,status,source,quantity_note`, [userId, recipe.rows[0].name, eatenAt || null, note]);
    await pool.query(`INSERT INTO recipe_entries (entry_id, recipe_id, ingredients_snapshot) VALUES ($1,$2,$3)`, [result.rows[0].id, req.params.id, JSON.stringify(ingredients.rows)]);
    res.status(201).json({ entry: { ...result.rows[0], recipe_id: req.params.id, ingredients: ingredients.rows } });
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

app.listen(port, () => console.log(`LITERIG Life Coach API listening on port ${port}`));
