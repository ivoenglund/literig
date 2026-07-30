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

// Fineli component codes. Energy is published in kJ; ALA in mg. Convert explicitly.
const DISPLAY_NUTRIENTS = [
  ['enerc', 'Energy', 'kcal', 1 / 4.184], ['prot', 'Protein', 'g', 1], ['fat', 'Fat', 'g', 1],
  ['choavl', 'Carbohydrate', 'g', 1], ['fibc', 'Fiber', 'g', 1], ['ca', 'Calcium', 'mg', 1],
  ['fe', 'Iron', 'mg', 1], ['zn', 'Zinc', 'mg', 1], ['se', 'Selenium', 'µg', 1], ['id', 'Iodine', 'µg', 1],
  ['fol', 'Folate', 'µg', 1], ['vitc', 'Vitamin C', 'mg', 1], ['vita', 'Vitamin A', 'µg', 1],
  ['vitk', 'Vitamin K', 'µg', 1], ['vite', 'Vitamin E', 'mg', 1], ['thia', 'Vitamin B1', 'mg', 1],
  ['ribf', 'Vitamin B2', 'mg', 1], ['niaeq', 'Vitamin B3', 'mg', 1], ['vitpyrid', 'Vitamin B6', 'mg', 1],
  ['vitb12', 'Vitamin B12', 'µg', 1], ['vitd', 'Vitamin D', 'µg', 1], ['f18d3n3', 'Omega-3 ALA', 'g', 0.001]
];

async function calculateSnapshotNutrition(client, snapshot) {
  const items = Array.isArray(snapshot) ? snapshot : [];
  const result = await client.query(`
    WITH items AS (SELECT x.*, row_number() OVER () AS item_no FROM jsonb_to_recordset($1::jsonb) AS x(name text, amount numeric, unit text, food_id uuid)),
    linked AS (
      SELECT i.*, f.id AS matched_food_id, f.basis_amount
      FROM items i
      LEFT JOIN foods f ON f.id=i.food_id AND f.basis_amount=100 AND f.basis_unit='g' AND f.status='verified'
    ),
    calculable AS (SELECT * FROM linked WHERE unit='g' AND amount > 0 AND matched_food_id IS NOT NULL),
    values_by_code AS (
      SELECT n.code,
        SUM(fn.value * l.amount / l.basis_amount) AS total,
        COUNT(DISTINCT l.item_no)::int AS supporting_ingredients
      FROM calculable l
      JOIN food_nutrients fn ON fn.food_id=l.matched_food_id
      JOIN nutrients n ON n.id=fn.nutrient_id
      WHERE n.code = ANY($2::text[])
      GROUP BY n.code
    )
    SELECT (SELECT count(*)::int FROM items) AS ingredient_count,
      (SELECT count(*)::int FROM linked WHERE unit='g' AND amount > 0) AS gram_ingredient_count,
      (SELECT count(*)::int FROM calculable) AS linked_gram_ingredient_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',name,'amount',amount,'unit',unit,'reason',CASE WHEN unit IS DISTINCT FROM 'g' THEN 'amount is not an explicit gram weight' WHEN amount IS NULL OR amount <= 0 THEN 'amount is missing or not positive' WHEN food_id IS NULL THEN 'no verified Fineli food link' ELSE 'linked Fineli food is unavailable' END) ORDER BY name) FROM linked WHERE unit IS DISTINCT FROM 'g' OR amount IS NULL OR amount <= 0 OR matched_food_id IS NULL), '[]'::jsonb) AS unresolved,
      COALESCE((SELECT jsonb_object_agg(code, jsonb_build_object('total', total, 'supporting_ingredients', supporting_ingredients)) FROM values_by_code), '{}'::jsonb) AS totals
  `, [JSON.stringify(items), DISPLAY_NUTRIENTS.map(([code]) => code)]);
  const row = result.rows[0], raw = row.totals || {};
  return { nutrients: DISPLAY_NUTRIENTS.map(([code, name, unit, factor]) => ({ code, name, unit, value: raw[code] == null ? null : Number(raw[code].total) * factor, supporting_ingredients: Number(raw[code]?.supporting_ingredients || 0) })), coverage: { ingredients: Number(row.ingredient_count), gram_ingredients: Number(row.gram_ingredient_count), linked_gram_ingredients: Number(row.linked_gram_ingredient_count), unresolved: row.unresolved } };
}

async function verifiedFineliIngredients(client, ingredients) {
  // A client may only persist a link after explicitly choosing a current,
  // verified Fineli 100 g record. Unknown IDs are kept visibly unmatched.
  const items = Array.isArray(ingredients) ? ingredients : [];
  const ids = [...new Set(items.map((item) => String(item.food_id || '')).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))];
  if (!ids.length) return items.map((item) => ({ ...item, food_id: null }));
  const result = await client.query(`SELECT id FROM foods WHERE id = ANY($1::uuid[]) AND status='verified' AND fineli_food_id IS NOT NULL AND basis_amount=100 AND basis_unit='g'`, [ids]);
  const allowed = new Set(result.rows.map((row) => row.id));
  return items.map((item) => ({ ...item, food_id: allowed.has(item.food_id) ? item.food_id : null }));
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

function stripHtml(html){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim().slice(0,50000)}
function imageCandidates(html){const found=[];for(const re of [/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/gi,/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/gi,/<img[^>]+src=["']([^"']+)["']/gi])for(const m of html.matchAll(re))if(/^https?:\/\//i.test(m[1]))found.push(m[1]);for(const m of html.matchAll(/"image"\s*:\s*"(https?:\\?\/\\?\/[^"']+)/gi))found.push(m[1].replace(/\\\//g,'/'));return [...new Set(found)].slice(0,20)}
async function downloadRecipeImage(url){if(!url)return {data:null,mime:null};try{const r=await fetch(url,{redirect:'follow',headers:{'User-Agent':'literig recipe importer/1.0'}});if(!r.ok)return {data:null,mime:null};const mime=(r.headers.get('content-type')||'').split(';')[0];if(!mime.startsWith('image/')||Number(r.headers.get('content-length')||0)>10000000)return {data:null,mime:null};return {data:Buffer.from(await r.arrayBuffer()),mime}}catch{return {data:null,mime:null}}}
function safeRecipeUrl(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol))return null;if(['localhost','127.0.0.1','0.0.0.0'].includes(u.hostname)||u.hostname.endsWith('.local'))return null;return u.toString()}catch{return null}}
function parseModelJson(content){let text=String(content||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(text)}catch{const start=text.indexOf('{'),end=text.lastIndexOf('}');if(start>=0&&end>start)return JSON.parse(text.slice(start,end+1));throw new Error('AI returned incomplete recipe data')}}
async function callFalRouter(messages){const key=process.env.FAL_KEY||process.env.OPENROUTER_API_KEY;if(!key)throw new Error('FAL_KEY is not configured on lifecoach-api');const response=await fetch('https://fal.run/openrouter/router/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Key ${key}`},body:JSON.stringify({model:'google/gemini-2.5-flash',temperature:0,max_tokens:1800,response_format:{type:'json_object'},messages})});if(!response.ok)throw new Error(`AI gateway returned ${response.status}`);const data=await response.json();return parseModelJson(data.choices?.[0]?.message?.content||'{}')}

app.post('/api/recipe-import/preview', async (req,res)=>{const url=safeRecipeUrl(req.body?.url);if(!url)return res.status(400).json({error:'A public http(s) recipe URL is required'});try{const page=await fetch(url,{redirect:'follow',headers:{'User-Agent':'literig recipe importer/1.0'}});if(!page.ok)throw new Error(`Recipe page returned ${page.status}`);const html=await page.text();const result=await callFalRouter([{role:'system',content:'Extract a recipe for human review. Return JSON only with keys name,description,instructions,ingredients (array of name,amount,unit,amount_grams,original_amount,original_unit),image_url. Preserve the original ingredient amount and unit for display (for example 2 apples, 2 dl sugar, 1 tbsp oil). Also provide amount_grams only when a safe, ingredient-specific conversion is reliable; otherwise use null. Never replace a missing conversion with zero or a guess. Choose one image only from the supplied candidates, or null.'},{role:'user',content:JSON.stringify({url,text:stripHtml(html).slice(0,50000),image_candidates:imageCandidates(html)})}]);res.json({source_url:url,preview:{name:String(result.name||'Imported recipe'),description:result.description||'',instructions:result.instructions||'',ingredients:Array.isArray(result.ingredients)?result.ingredients:[],image_url:result.image_url||null}})}catch(error){console.error('Recipe import preview failed:',error.message);res.status(502).json({error:'Could not create recipe preview',detail:error.message})}});

app.post('/api/recipe-import/approve', async (req,res)=>{if(!pool)return res.status(503).json({error:'Database not configured'});const p=req.body?.preview;if(!p?.name||!Array.isArray(p.ingredients))return res.status(400).json({error:'A reviewed recipe preview is required'});const client=await pool.connect();try{await client.query('BEGIN');const image=await downloadRecipeImage(p.image_url);const recipe=(await client.query(`INSERT INTO recipes (name,description,instructions,servings,image_url,image_data,image_mime) VALUES ($1,$2,$3,1,$4,$5,$6) ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description,instructions=EXCLUDED.instructions,image_url=EXCLUDED.image_url,image_data=EXCLUDED.image_data,image_mime=EXCLUDED.image_mime RETURNING id,name,image_url`,[p.name,p.description||'',p.instructions||'',p.image_url||null,image.data,image.mime])).rows[0];await client.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1',[recipe.id]);for(const [i,item] of p.ingredients.entries())await client.query('INSERT INTO recipe_ingredients(recipe_id,ingredient_name,amount,unit,original_amount,original_unit,amount_grams,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[recipe.id,String(item.name||'').trim(),item.amount_grams==null?0:Number(item.amount_grams),'g',item.original_amount??item.amount??null,item.original_unit||item.unit||'g',item.amount_grams==null?null:Number(item.amount_grams),i]);await client.query('COMMIT');res.status(201).json({recipe})}catch(error){await client.query('ROLLBACK');console.error('Recipe import approval failed:',error.message);res.status(500).json({error:'Could not save imported recipe'})}finally{client.release()}});

app.post('/api/text-entry/interpret', async (req,res)=>{const text=String(req.body?.text||'').trim();if(!text)return res.status(400).json({error:'text is required'});try{const result=await callFalRouter([{role:'system',content:'Classify the Swedish user text. Return JSON only: type must be exactly recipe, meal, or note. For recipe include name, instructions, ingredients array with name, amount, unit (convert to grams when possible). For meal include a concise description in Swedish. For note include a concise description. Never invent quantities.'},{role:'user',content:text}]);res.json({type:['recipe','meal','note'].includes(result.type)?result.type:'note',result})}catch(error){console.error('Text interpretation failed:',error.message);res.status(502).json({error:'Could not interpret text'})}});

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
  const query = String(req.query.q || '').trim().replace(/\s+/g, ' ');
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (query.length < 2 || !tokens.length) return res.json({ foods: [], note: 'Search needs at least two characters; no approximate food is selected automatically.' });
  try {
    // Word-boundary tokens prevent a partial word from becoming a proposed basic
    // ingredient. Prepared dishes and branded drinks are never candidates here.
    const result = await pool.query(`
      SELECT id, name, name_sv, name_fi, state, fineli_food_id, source_name
      FROM foods
      WHERE status='verified' AND basis_amount=100 AND basis_unit='g' AND fineli_food_id IS NOT NULL
        AND NOT (state IN ('MIX', 'REC', 'DRINK') OR name ~* '(mix|wok|soup|stew|hamburger|casserole|gravy|dessert|ice cream|frankfurter|noodle|pizza|sandwich|salad|curry|smoothie|juice|drink|beverage|babyfood|filled|cutlet|patty|pastie|pie|pudding|porridge|meal|powder|chicken|turkey|beef|pork|lamb|fish|sausage|meatball|cereal|cake|cookie|biscuit|chocolate|yogurt|yoghurt|cheese|milk|cream|mayonnaise|dressing|spread|jam|marmalade|sauce|with salt|with butter|in milk)')
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS token
          WHERE COALESCE(name, '') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)')
            AND COALESCE(name_sv, '') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)')
            AND COALESCE(name_fi, '') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)')
        )
      ORDER BY CASE WHEN lower(name)=lower($2) THEN 0 WHEN lower(name) LIKE lower($2) || ',%' THEN 1 ELSE 2 END, length(name), name
      LIMIT 20`, [tokens, query]);
    res.json({ foods: result.rows, note: 'Choose the exact Fineli record and preparation state yourself. Results are not automatically matched; dishes and drinks are excluded.' });
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
    const entries = await pool.query(`SELECT fe.nutrition_estimate, re.ingredients_snapshot FROM food_entries fe LEFT JOIN recipe_entries re ON re.entry_id=fe.id WHERE fe.user_id=$1 AND fe.eaten_at::date=$2`, [userId, targetDate]);
    const sums = Object.fromEntries(DISPLAY_NUTRIENTS.map(([code]) => [code, 0]));
    const available = Object.fromEntries(DISPLAY_NUTRIENTS.map(([code]) => [code, false]));
    const sourceIngredients = Object.fromEntries(DISPLAY_NUTRIENTS.map(([code]) => [code, 0]));
    const unresolved = []; let gramIngredients = 0, linkedGramIngredients = 0;
    for (const entry of entries.rows) {
      const snapshot = entry.nutrition_estimate || {};
      const coverage = snapshot.coverage || {};
      gramIngredients += Number(coverage.gram_ingredients || 0);
      linkedGramIngredients += Number(coverage.linked_gram_ingredients || 0);
      unresolved.push(...(Array.isArray(coverage.unresolved) ? coverage.unresolved : []));
      const nutrients = Array.isArray(snapshot.nutrients) ? snapshot.nutrients : [
        ['enerc','kcal'],['prot','protein_g'],['fat','fat_g'],['choavl','carbohydrate_g'],['fibc','fiber_g'],['ca','calcium_mg'],['fe','iron_mg'],['zn','zinc_mg'],['vitc','vitamin_c_mg'],['fol','folate_ug'],['vitb12','vitamin_b12_ug'],['vitd','vitamin_d_ug']
      ].map(([code,key]) => ({code,value:snapshot[key],supporting_ingredients:1}));
      for (const nutrient of nutrients) if (nutrient.value != null) { const target=DISPLAY_NUTRIENTS.find(([code])=>code===nutrient.code); if(!target) continue; sums[nutrient.code] += Number(nutrient.value); available[nutrient.code] = true; sourceIngredients[nutrient.code] += Number(nutrient.supporting_ingredients || 1); }
    }
    const nutrients = DISPLAY_NUTRIENTS.map(([code, name, unit]) => ({ code, name, unit, value: available[code] ? sums[code] : null, source_ingredients: sourceIngredients[code],
      status: !entries.rows.length ? 'no_recipe_data' : (!available[code] ? 'missing_source_coverage' : (sourceIngredients[code] < linkedGramIngredients || gramIngredients !== linkedGramIngredients ? 'partial_coverage' : 'covered')) }));
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
  const result = await pool.query(`SELECT r.id, r.name, r.description, r.instructions, r.servings, r.image_url, CASE WHEN r.image_data IS NOT NULL THEN 'data:'||r.image_mime||';base64,'||encode(r.image_data,'base64') ELSE NULL END AS image_data_uri, COALESCE(json_agg(json_build_object('name',ri.ingredient_name,'amount',ri.amount,'unit',ri.unit,'food_id',ri.food_id,'state',f.state,'source_name',f.source_name,'fineli_food_id',f.fineli_food_id) ORDER BY ri.sort_order) FILTER (WHERE ri.id IS NOT NULL), '[]') AS ingredients FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id=r.id LEFT JOIN foods f ON f.id=ri.food_id GROUP BY r.id ORDER BY r.name`);
  res.json({ recipes: result.rows });
});

app.put('/api/recipes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { name, instructions, image_url: imageUrl = null, ingredients = [] } = req.body;
  if (typeof instructions !== 'string' || typeof name !== 'string') return res.status(400).json({ error: 'name and instructions are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storedImage=await downloadRecipeImage(imageUrl);const result = await client.query('UPDATE recipes SET name=$1,instructions=$2,image_url=$3,image_data=$4,image_mime=$5 WHERE id=$6 RETURNING id,name,instructions,image_url', [name.trim(), instructions.trim(), imageUrl, storedImage.data, storedImage.mime, req.params.id]);
    if (!result.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Recipe not found' }); }
    await client.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [req.params.id]);
    for (const [index, item] of ingredients.entries()) {
      await client.query('INSERT INTO recipe_ingredients(recipe_id,ingredient_name,amount,unit,sort_order) VALUES($1,$2,$3,$4,$5)', [req.params.id, String(item.name || '').trim(), item.amount == null ? null : Number(item.amount), String(item.unit || 'g').trim(), index]);
    }
    await client.query('COMMIT'); res.json({ recipe: result.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); console.error('Recipe update failed:', error.message); res.status(500).json({ error: 'Could not update recipe' }); }
  finally { client.release(); }
});

app.post('/api/recipes/:id/log', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, eaten_at: eatenAt, note = null } = req.body;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const recipe = await pool.query('SELECT name FROM recipes WHERE id=$1', [req.params.id]);
    if (!recipe.rows[0]) return res.status(404).json({ error: 'Recipe not found' });
    const ingredients = await pool.query(`SELECT ri.ingredient_name AS name, ri.amount, ri.unit, ri.food_id, ri.preparation_state, f.state AS food_state, f.basis_amount, f.basis_unit, f.source_name, f.source_id FROM recipe_ingredients ri LEFT JOIN foods f ON f.id=ri.food_id WHERE ri.recipe_id=$1 ORDER BY ri.sort_order`, [req.params.id]);
    const calculation = await calculateSnapshotNutrition(pool, ingredients.rows);
    const result = await pool.query(`INSERT INTO food_entries (user_id, description, eaten_at, status, source, quantity_note, nutrition_estimate) VALUES ($1,$2,COALESCE($3,now()),'confirmed','recipe',$4,$5) RETURNING id,eaten_at,description,status,source,quantity_note,nutrition_estimate`, [userId, recipe.rows[0].name, eatenAt || null, note, JSON.stringify({ source: 'normalized_foods', nutrients: calculation.nutrients, coverage: calculation.coverage, basis: 'Fineli food_nutrients per 100 g at logging time' })]);
    await pool.query(`INSERT INTO recipe_entries (entry_id, recipe_id, ingredients_snapshot) VALUES ($1,$2,$3)`, [result.rows[0].id, req.params.id, JSON.stringify(ingredients.rows)]);
    res.status(201).json({ entry: { ...result.rows[0], recipe_id: req.params.id, ingredients: ingredients.rows, nutrition: calculation } });
  } catch (error) { console.error('Recipe log failed:', error); res.status(500).json({ error: 'Could not log recipe', detail: error.message }); }
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
    const summary = result.rows[0];
    res.json({ summary, nutrition_status: Number(summary.confirmed_entries) > 0 ? 'normalized_snapshots_available' : 'waiting_for_quantities' });
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

app.post('/api/entries/:id/convert-to-recipe', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.body?.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  const client = await pool.connect();
  try { await client.query('BEGIN'); const entry = await client.query('SELECT id, description FROM food_entries WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id, userId]); if (!entry.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Entry not found' }); } const recipe = await client.query(`INSERT INTO recipes (name, description, instructions, servings) VALUES ($1,$2,'',1) ON CONFLICT (name) DO UPDATE SET name=recipes.name RETURNING id,name`, [entry.rows[0].description, entry.rows[0].description]); await client.query("UPDATE food_entries SET source='recipe' WHERE id=$1 AND user_id=$2", [req.params.id,userId]); await client.query("INSERT INTO recipe_entries (entry_id,recipe_id,ingredients_snapshot) VALUES ($1,$2,'[]'::jsonb)", [req.params.id,recipe.rows[0].id]); await client.query('COMMIT'); res.status(201).json({ recipe: recipe.rows[0] }); }
  catch (error) { await client.query('ROLLBACK'); console.error('Convert entry to recipe failed:', error.message); res.status(500).json({ error: 'Could not convert entry to recipe' }); } finally { client.release(); }
});
app.delete('/api/entries/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const userId = req.query.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try { const result = await pool.query('DELETE FROM food_entries WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, userId]); if (!result.rows[0]) return res.status(404).json({ error: 'Entry not found' }); res.status(204).end(); }
  catch (error) { console.error('Entry delete failed:', error.message); res.status(500).json({ error: 'Could not delete entry' }); }
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
    const normalizedIngredients = ingredients.map((item) => ({
      ...item,
      amount: item.amount === null || item.amount === '' ? null : Number(item.amount),
      unit: typeof item.unit === 'string' ? item.unit : 'g',
      preparation_state: ['raw', 'cooked', 'dry', 'powdered', 'frozen', 'fortified', 'volume', 'unresolved'].includes(item.preparation_state) ? item.preparation_state : 'unresolved'
    }));
    if (normalizedIngredients.some((item) => !Number.isFinite(item.amount) && item.amount !== null)) return res.status(400).json({ error: 'Ingredient amounts must be numbers or explicitly missing' });
    const safeIngredients = await verifiedFineliIngredients(pool, normalizedIngredients);
    if (update_standard) {
      if (safeIngredients.some((item) => item.amount === null || item.amount <= 0)) return res.status(400).json({ error: 'Standard recipes require a positive amount for every ingredient; keep unknown amounts in the day instance instead' });
      await pool.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [recipeId]);
      for (const [i, item] of safeIngredients.entries()) await pool.query('INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount, unit, food_id, preparation_state, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [recipeId, item.name, item.amount, item.unit, item.food_id || null, item.preparation_state, i]);
    }
    const calculation = await calculateSnapshotNutrition(pool, safeIngredients);
    await pool.query('UPDATE recipe_entries SET ingredients_snapshot=$1, updated_at=now() WHERE entry_id=$2', [JSON.stringify(safeIngredients), req.params.entryId]);
    await pool.query('UPDATE food_entries SET nutrition_estimate=$1, quantity_note=$2 WHERE id=$3 AND user_id=$4', [JSON.stringify({ source: 'normalized_foods', nutrients: calculation.nutrients, coverage: calculation.coverage, basis: 'Fineli food_nutrients per 100 g at edit time' }), 'Ingredienser redigerade för denna dag', req.params.entryId, userId]);
    res.json({ entry_id: req.params.entryId, ingredients: safeIngredients, nutrition: calculation, standard_updated: update_standard });
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
  for (const filename of ['002_normalized_nutrition.sql', '003_import_fineli_verified_foods.sql', '004_english_recipes.sql', '005_link_recipe_ingredients_fineli.sql', '006_recipe_snapshot_nutrition.sql', '007_restore_verified_spinach.sql', '008_unlink_ambiguous_seed_tofu.sql', '009_fineli_import_staging.sql', '010_explicit_recipe_preparation_state.sql', '010_retire_legacy_food_catalog.sql', '011_recipe_image.sql', '012_recipe_image_data.sql', '013_recipe_original_units.sql']) {
    const sql = await fs.readFile(path.join(process.cwd(), 'migrations', filename), 'utf8');
    await pool.query(sql);
  }
  console.log('Fineli nutrition migrations applied');
  // Full Fineli import is intentionally not run at API startup. It must run in resumable batches.
}

applyNutritionMigrations()
  .then(() => app.listen(port, () => console.log(`LITERIG Life Coach API listening on port ${port}`)))
  .catch((error) => { console.error('Nutrition migration failed:', error.message); process.exit(1); });
