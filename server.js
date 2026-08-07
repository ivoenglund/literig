import express from 'express';
import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { createHash, randomBytes } from 'node:crypto';
import cookieParser from 'cookie-parser';
import { Resend } from 'resend';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getFineliCatalogStatus, importFullFineli } from './import-fineli-full.js';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const SESSION_COOKIE = 'livingonplants_session';
const SESSION_DAYS = 14;

// Fineli stores ENERC in kJ and the importer stores the separately-derived kcal row.
const DISPLAY_NUTRIENTS = [
  ['energy_kcal', 'Energy', 'kcal', 1], ['prot', 'Protein', 'g', 1], ['fat', 'Fat', 'g', 1],
  ['choavl', 'Carbohydrate', 'g', 1], ['fibc', 'Fiber', 'g', 1], ['ca', 'Calcium', 'mg', 1],
  ['fe', 'Iron', 'mg', 1], ['zn', 'Zinc', 'mg', 1], ['se', 'Selenium', 'µg', 1], ['id', 'Iodine', 'µg', 1],
  ['fol', 'Folate', 'µg', 1], ['vitc', 'Vitamin C', 'mg', 1], ['vita', 'Vitamin A', 'µg', 1],
  ['vitk', 'Vitamin K', 'µg', 1], ['vite', 'Vitamin E', 'mg', 1], ['thia', 'Vitamin B1', 'mg', 1],
  ['ribf', 'Vitamin B2', 'mg', 1], ['niaeq', 'Vitamin B3', 'mg', 1], ['vitpyrid', 'Vitamin B6', 'mg', 1],
  ['vitb12', 'Vitamin B12', 'µg', 1], ['vitd', 'Vitamin D', 'µg', 1], ['f18d3n3', 'Omega-3 ALA', 'g', 0.001]
];

function safeGramAmount(amount, unit, gramsPerUnit = null) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  if (Number.isFinite(Number(gramsPerUnit)) && Number(gramsPerUnit) > 0) return value * Number(gramsPerUnit);
  const aliases = { milligram: 'mg', milligrams: 'mg', milligramm: 'mg', milligram: 'mg', gram: 'g', grams: 'g', grammer: 'g', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', hekto: 'hg', hektogram: 'hg' };
  const normalized = String(unit || '').trim().toLowerCase();
  const canonical = aliases[normalized] || normalized;
  const factors = { mg: 0.001, g: 1, hg: 100, kg: 1000 };
  const factor = factors[canonical];
  return factor == null ? null : value * factor;
}
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}
function normalizeIngredient(item = {}) {
  const amount = numberOrNull(item.amount);
  const unit = String(item.unit || item.original_unit || 'g').trim();
  const originalAmount = numberOrNull(item.original_amount);
  const requestedGrams = numberOrNull(item.amount_grams);
  return {
    name: String(item.name || '').trim(), amount, unit,
    original_amount: originalAmount == null ? amount : originalAmount,
    original_unit: String(item.original_unit || unit).trim(),
    amount_grams: requestedGrams == null ? safeGramAmount(amount, unit, item.grams_per_unit) : requestedGrams,
    food_id: item.food_id || null,
    preparation_state: ['raw', 'cooked', 'dry', 'powdered', 'frozen', 'fortified', 'volume', 'unresolved'].includes(item.preparation_state) ? item.preparation_state : 'unresolved'
  };
}
function containsReplacementCharacter(value) { return String(value ?? '').includes('\uFFFD'); }
function storedRecipeAmount(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }

async function calculateSnapshotNutrition(client, snapshot) {
  const items = Array.isArray(snapshot) ? snapshot : [];
  const result = await client.query(`
    WITH items AS (SELECT x.*, row_number() OVER () AS item_no FROM jsonb_to_recordset($1::jsonb) AS x(name text, amount numeric, unit text, food_id uuid, amount_grams numeric, original_amount numeric, original_unit text)),
    linked AS (
      SELECT i.*, f.id AS matched_food_id, f.basis_amount
      FROM items i
      LEFT JOIN foods f ON f.id=i.food_id AND f.basis_amount=100 AND f.basis_unit='g' AND f.status='verified'
    ),
    calculable AS (SELECT *, COALESCE(amount_grams, CASE WHEN unit='g' THEN amount END) AS calculation_grams FROM linked WHERE COALESCE(amount_grams, CASE WHEN unit='g' THEN amount END) > 0 AND matched_food_id IS NOT NULL),
    values_by_code AS (
      SELECT n.code,
        SUM(fn.value * l.calculation_grams / l.basis_amount) AS total,
        COUNT(DISTINCT l.item_no)::int AS supporting_ingredients
      FROM calculable l
      JOIN food_nutrients fn ON fn.food_id=l.matched_food_id
      JOIN nutrients n ON n.id=fn.nutrient_id
      WHERE n.code = ANY($2::text[])
      GROUP BY n.code
    )
    SELECT (SELECT count(*)::int FROM items) AS ingredient_count,
      (SELECT count(*)::int FROM linked WHERE COALESCE(amount_grams, CASE WHEN unit='g' THEN amount END) > 0) AS gram_ingredient_count,
      (SELECT count(*)::int FROM calculable) AS linked_gram_ingredient_count,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',name,'amount',amount,'unit',unit,'amount_grams',amount_grams,'original_amount',original_amount,'original_unit',original_unit,'reason',CASE WHEN COALESCE(amount_grams, CASE WHEN unit='g' THEN amount END) IS NULL THEN 'no safe gram conversion is available' WHEN COALESCE(amount_grams, CASE WHEN unit='g' THEN amount END) <= 0 THEN 'amount is missing or not positive' WHEN food_id IS NULL THEN 'no verified Fineli food link' ELSE 'linked Fineli food is unavailable' END) ORDER BY name) FROM linked WHERE COALESCE(amount_grams, CASE WHEN unit='g' THEN amount END) IS NULL OR COALESCE(amount_grams, CASE WHEN unit='g' THEN amount END) <= 0 OR matched_food_id IS NULL), '[]'::jsonb) AS unresolved,
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
  res.setHeader('Access-Control-Allow-Origin', 'https://lifeonplants.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended:false }));
app.use(cookieParser());
app.use('/api/recipe-import/approve', (req, _res, next) => {
  if (req.method === 'POST' && Array.isArray(req.body?.preview?.ingredients)) {
    const units = /^(kg|hg|g|mg|dl|cl|ml|l|msk|tsk|krm|st|portion|portions)$/i;
    const parseAmount = (value) => { const text = String(value ?? '').trim().replace(',', '.'); if (/^\d+\s*\/\s*\d+$/.test(text)) { const [a, b] = text.split('/').map(Number); return b ? a / b : null; } const number = Number(text); return Number.isFinite(number) ? number : null; };
    req.body.preview.ingredients = req.body.preview.ingredients.map((item) => { const amount = parseAmount(item.amount ?? item.original_amount); const rawUnit = String(item.original_unit ?? item.unit ?? '').trim(); const unit = units.test(rawUnit) ? rawUnit : 'unresolved'; const grams = Number(item.amount_grams); return { ...item, amount, unit, original_amount: amount, original_unit: rawUnit || 'unresolved', amount_grams: Number.isFinite(grams) ? grams : null }; });
  }
  next();
});
app.use(express.static('.'));

function stripHtml(html){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim().slice(0,50000)}
function imageCandidates(html){const found=[];for(const re of [/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/gi,/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/gi,/<img[^>]+src=["']([^"']+)["']/gi])for(const m of html.matchAll(re))if(/^https?:\/\//i.test(m[1]))found.push(m[1]);for(const m of html.matchAll(/"image"\s*:\s*"(https?:\\?\/\\?\/[^"']+)/gi))found.push(m[1].replace(/\\\//g,'/'));return [...new Set(found)].slice(0,20)}
async function downloadRecipeImage(url){if(!url)return {data:null,mime:null};try{const r=await fetch(url,{redirect:'follow',headers:{'User-Agent':'lifeonplants recipe importer/1.0'}});if(!r.ok)return {data:null,mime:null};const mime=(r.headers.get('content-type')||'').split(';')[0];if(!mime.startsWith('image/')||Number(r.headers.get('content-length')||0)>10000000)return {data:null,mime:null};return {data:Buffer.from(await r.arrayBuffer()),mime}}catch{return {data:null,mime:null}}}
function safeRecipeUrl(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol))return null;if(['localhost','127.0.0.1','0.0.0.0'].includes(u.hostname)||u.hostname.endsWith('.local'))return null;return u.toString()}catch{return null}}
function parseModelJson(content){let text=String(content||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');try{return JSON.parse(text)}catch{const start=text.indexOf('{'),end=text.lastIndexOf('}');if(start>=0&&end>start)return JSON.parse(text.slice(start,end+1));throw new Error('AI returned incomplete recipe data')}}
async function aiConfig(){const fallback={model:'google/gemini-2.5-flash',input_cost_per_million_usd:0,output_cost_per_million_usd:0};if(!pool)return fallback;try{return {...fallback,...(await pool.query('SELECT model,input_cost_per_million_usd,output_cost_per_million_usd FROM ai_provider_settings WHERE singleton=TRUE')).rows[0]}}catch{return fallback}}
async function recordAiUsage(config,operation,usage,success,errorCode=null){if(!pool)return;const input=Number(usage?.prompt_tokens||0),output=Number(usage?.completion_tokens||0),total=Number(usage?.total_tokens||input+output),cost=(input*Number(config.input_cost_per_million_usd||0)+output*Number(config.output_cost_per_million_usd||0))/1000000;try{await pool.query('INSERT INTO ai_usage_events(operation,provider,model,input_tokens,output_tokens,total_tokens,estimated_cost_usd,success,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[operation,'fal',config.model,input,output,total,cost,success,errorCode])}catch(error){console.error('AI usage logging failed:',error.message)}}
async function callFalRouter(messages,operation='recipe_import'){const key=process.env.FAL_KEY||process.env.OPENROUTER_API_KEY;if(!key)throw new Error('FAL_KEY is not configured for Living on Plants');const config=await aiConfig();try{const response=await fetch('https://fal.run/openrouter/router/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Key ${key}`},body:JSON.stringify({model:config.model,temperature:0,max_tokens:1800,response_format:{type:'json_object'},messages})});if(!response.ok){await recordAiUsage(config,operation,null,false,String(response.status));throw new Error(`AI gateway returned ${response.status}`)}const data=await response.json();await recordAiUsage(config,operation,data.usage,true);return parseModelJson(data.choices?.[0]?.message?.content||'{}')}catch(error){if(!/AI gateway returned/.test(error.message))await recordAiUsage(config,operation,null,false,'request_failed');throw error}}

app.post('/api/recipe-import/preview', async (req,res)=>{const user=await sessionUser(req);if(!isAdminEmail(user?.email))return res.sendStatus(404);const url=safeRecipeUrl(req.body?.url);if(!url)return res.status(400).json({error:'A public http(s) recipe URL is required'});try{const page=await fetch(url,{redirect:'follow',headers:{'User-Agent':'lifeonplants recipe importer/1.0'}});if(!page.ok)throw new Error(`Recipe page returned ${page.status}`);const html=await page.text();const result=await callFalRouter([{role:'system',content:'Extract a recipe for human review. Return JSON only with keys name,description,instructions,ingredients (array of name,amount,unit,amount_grams,original_amount,original_unit),image_url. Preserve the original ingredient amount and unit for display (for example 2 apples, 2 dl sugar, 1 tbsp oil). Also provide amount_grams only when a safe, ingredient-specific conversion is reliable; otherwise use null. Never replace a missing conversion with zero or a guess. Choose one image only from the supplied candidates, or null.'},{role:'user',content:JSON.stringify({url,text:stripHtml(html).slice(0,50000),image_candidates:imageCandidates(html)})}]);res.json({source_url:url,preview:{name:String(result.name||'Imported recipe'),description:result.description||'',instructions:result.instructions||'',ingredients:Array.isArray(result.ingredients)?result.ingredients:[],image_url:result.image_url||null}})}catch(error){console.error('Recipe import preview failed:',error.message);res.status(502).json({error:'Could not create recipe preview',detail:error.message})}});

app.post('/api/recipe-import/approve', async (req,res)=>{const user=await sessionUser(req);if(!isAdminEmail(user?.email))return res.sendStatus(404);if(!pool)return res.status(503).json({error:'Database not configured'});const p=req.body?.preview;if(!p?.name||!Array.isArray(p.ingredients))return res.status(400).json({error:'A reviewed recipe preview is required'});const client=await pool.connect();try{await client.query('BEGIN');const image=await downloadRecipeImage(p.image_url);const recipe=(await client.query(`INSERT INTO recipes (name,description,instructions,servings,image_url,image_data,image_mime) VALUES ($1,$2,$3,1,$4,$5,$6) ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description,instructions=EXCLUDED.instructions,image_url=EXCLUDED.image_url,image_data=EXCLUDED.image_data,image_mime=EXCLUDED.image_mime RETURNING id,name,image_url`,[p.name,p.description||'',p.instructions||'',p.image_url||null,image.data,image.mime])).rows[0];await client.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1',[recipe.id]);for(const [i,item] of p.ingredients.entries())await client.query('INSERT INTO recipe_ingredients(recipe_id,ingredient_name,amount,unit,original_amount,original_unit,amount_grams,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[recipe.id,String(item.name||'').trim(),item.amount_grams==null?null:Number(item.amount_grams),item.amount_grams==null?(item.original_unit||item.unit||'g'):'g',item.original_amount??item.amount??null,item.original_unit||item.unit||'g',item.amount_grams==null?null:Number(item.amount_grams),i]);await client.query('COMMIT');res.status(201).json({recipe})}catch(error){await client.query('ROLLBACK');console.error('Recipe import approval failed:',error.message);res.status(500).json({error:'Could not save imported recipe'})}finally{client.release()}});

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
  try { res.json(await getFineliCatalogStatus(pool)); }
  catch (error) { console.error('Catalog status failed:', error.message); res.status(500).json({ error: 'Could not read catalog status' }); }
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

const hashToken = token => createHash('sha256').update(token).digest('hex');
const sessionCookieOptions = expires => ({ httpOnly:true, secure:process.env.NODE_ENV === 'production', sameSite:'lax', path:'/', expires });
async function sessionUser(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || !pool) return null;
  const result = await pool.query(`SELECT u.id,u.email FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hashToken(token)]);
  return result.rows[0] || null;
}
const isAdminEmail = email => Boolean(process.env.ADMIN_EMAIL && email && String(email).toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase());
app.get('/auth/me', async (req,res) => { try { const user=await sessionUser(req); res.json({user:user ? {...user,is_admin:isAdminEmail(user.email)} : null}); } catch { res.status(500).json({error:'Could not read session'}); } });
app.post('/auth/request-link', async (req,res) => {
  const email=String(req.body?.email||'').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({error:'Enter a valid email address'});
  if (!resend) return res.status(503).json({error:'Email delivery is not configured yet'});
  const token=randomBytes(32).toString('base64url'), expires=new Date(Date.now()+15*60*1000);
  try { await pool.query('INSERT INTO auth_magic_links(email,token_hash,expires_at) VALUES($1,$2,$3)',[email,hashToken(token),expires]); const origin=process.env.APP_URL||`${req.protocol}://${req.get('host')}`; const link=`${origin}/auth/verify?token=${encodeURIComponent(token)}`; const delivery=await resend.emails.send({from:process.env.EMAIL_FROM||'Living on Plants <noreply@livingonplants.com>',to:email,subject:'Your sign-in link for Living on Plants',html:`<p>Click below to sign in. This link expires in 15 minutes and can be used once.</p><p><a href="${link}" style="display:inline-block;padding:12px 18px;background:#22734e;color:#fff;border-radius:7px;text-decoration:none">Sign in to Living on Plants</a></p><p>If you did not request this, you can ignore this email.</p>`}); if(delivery.error) throw new Error(delivery.error.message); console.info('Magic link email accepted:',delivery.data?.id||'accepted'); res.json({ok:true}); } catch(error){console.error('Magic link send failed:',error.message);res.status(500).json({error:'Could not send sign-in link'});}
});
app.get('/auth/verify', (req,res) => { const token=String(req.query.token||''); if(!token)return res.redirect('/login.html?error=missing'); const safeToken=token.replace(/"/g,'&quot;'); res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Signing in · Living on Plants</title><form id="verify" method="post" action="/auth/verify"><input type="hidden" name="token" value="${safeToken}"></form><script>document.getElementById('verify').submit()</script>`); });
app.post('/auth/verify', async (req,res) => { const token=String(req.body?.token||''); if(!token)return res.redirect('/login.html?error=missing'); const client=await pool.connect(); try { await client.query('BEGIN'); const link=(await client.query('UPDATE auth_magic_links SET used_at=now() WHERE token_hash=$1 AND expires_at>now() AND used_at IS NULL RETURNING email',[hashToken(token)])).rows[0]; if(!link){await client.query('ROLLBACK');return res.redirect('/login.html?error=invalid');} await client.query(`DELETE FROM users u WHERE lower(u.email)=lower($1) AND NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id=u.id AND s.expires_at>now())`,[link.email]); const user=(await client.query('INSERT INTO users(email) VALUES($1) ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO UPDATE SET email=EXCLUDED.email RETURNING id,email',[link.email])).rows[0]; const sessionToken=randomBytes(32).toString('base64url'), expires=new Date(Date.now()+SESSION_DAYS*86400000); await client.query('INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)',[user.id,hashToken(sessionToken),expires]); await client.query('COMMIT'); res.cookie(SESSION_COOKIE,sessionToken,sessionCookieOptions(expires)); res.redirect('/'); } catch(error){await client.query('ROLLBACK');console.error('Magic link verify failed:',error.message);res.redirect('/login.html?error=server');} finally {client.release();} });
app.post('/auth/logout', async (req,res) => { const token=req.cookies?.[SESSION_COOKIE]; if(token&&pool)await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[hashToken(token)]);res.clearCookie(SESSION_COOKIE,{path:'/'});res.status(204).end(); });

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
  const matchingMode = req.query.mode === 'match';
  if (query.length < 2 || !tokens.length) return res.json({ foods: [], note: 'Search needs at least two characters; no approximate food is selected automatically.' });
  try {
    // Word-boundary tokens prevent a partial word from becoming a proposed basic
    // ingredient. Prepared dishes and branded drinks are never candidates here.
    const result = await pool.query(`
      SELECT id, COALESCE(display_name,name) AS name, name AS raw_name, display_name, name_sv, name_fi, state, fineli_food_id, source_name
      FROM foods
      WHERE status='verified' AND basis_amount=100 AND basis_unit='g' AND fineli_food_id IS NOT NULL
        AND ($3::boolean OR NOT (state IN ('MIX', 'REC', 'DRINK') OR name ~* '(mix|wok|soup|stew|hamburger|casserole|gravy|dessert|ice cream|frankfurter|noodle|pizza|sandwich|salad|curry|smoothie|juice|drink|beverage|babyfood|filled|cutlet|patty|pastie|pie|pudding|porridge|meal|powder|chicken|turkey|beef|pork|lamb|fish|sausage|meatball|cereal|cake|cookie|biscuit|chocolate|yogurt|yoghurt|cheese|milk|cream|mayonnaise|dressing|spread|jam|marmalade|sauce|with salt|with butter|in milk)'))
        AND NOT EXISTS (
          SELECT 1 FROM unnest($1::text[]) AS token
          WHERE COALESCE(name, '') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)')
            AND COALESCE(name_sv, '') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)')
            AND COALESCE(name_fi, '') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)')
        )
      ORDER BY CASE WHEN lower(name)=lower($2) THEN 0 WHEN lower(name) LIKE lower($2) || ',%' THEN 1 ELSE 2 END, length(COALESCE(display_name,name)), name
      LIMIT 20`, [tokens, query, matchingMode]);
    res.json({ foods: result.rows, note: 'Choose the exact Fineli record and preparation state yourself. Results are not automatically matched; dishes and drinks are excluded.' });
  } catch (error) {
    console.error('Food search failed:', error.message);
    res.status(500).json({ error: 'Could not search foods' });
  }
});

async function operatorAuthorized(req) {
  const user = await sessionUser(req);
  if (isAdminEmail(user?.email)) return true;
  const configured = process.env.ADMIN_DASHBOARD_TOKEN;
  const received = req.get('x-admin-token');
  if (!configured || !received) return false;
  const expected = Buffer.from(configured), actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
app.get('/api/ops/ai', async (req, res) => {
  if (!await operatorAuthorized(req)) return res.sendStatus(404);
  if (!pool) return res.status(503).json({ error:'Database not configured' });
  try {
    const [settings, daily, byModel] = await Promise.all([
      pool.query('SELECT provider,model,input_cost_per_million_usd,output_cost_per_million_usd,updated_at FROM ai_provider_settings WHERE singleton=TRUE'),
      pool.query(`SELECT created_at::date AS day, COUNT(*)::int AS requests, COALESCE(SUM(estimated_cost_usd),0) AS cost_usd, COALESCE(SUM(total_tokens),0)::int AS tokens FROM ai_usage_events WHERE created_at >= now()-interval '30 days' GROUP BY 1 ORDER BY 1 DESC`),
      pool.query(`SELECT provider,model,COUNT(*)::int AS requests,COALESCE(SUM(estimated_cost_usd),0) AS cost_usd,COALESCE(SUM(total_tokens),0)::int AS tokens FROM ai_usage_events WHERE created_at >= now()-interval '30 days' GROUP BY 1,2 ORDER BY cost_usd DESC`)
    ]);
    res.json({ settings:settings.rows[0], daily:daily.rows, by_model:byModel.rows, balance_usd:null, balance_note:'Fal account balance is not exposed through this application.' });
  } catch (error) { console.error('AI dashboard read failed:',error.message); res.status(500).json({ error:'Could not load AI dashboard' }); }
});
app.put('/api/ops/ai/settings', async (req, res) => {
  if (!await operatorAuthorized(req)) return res.sendStatus(404);
  if (!pool) return res.status(503).json({ error:'Database not configured' });
  const { model, input_cost_per_million_usd: inputCost, output_cost_per_million_usd: outputCost } = req.body || {};
  if (typeof model !== 'string' || !model.trim() || !Number.isFinite(Number(inputCost)) || !Number.isFinite(Number(outputCost))) return res.status(400).json({ error:'model and token prices are required' });
  try { const result=await pool.query(`UPDATE ai_provider_settings SET provider='fal',model=$1,input_cost_per_million_usd=$2,output_cost_per_million_usd=$3,updated_at=now() WHERE singleton=TRUE RETURNING provider,model,input_cost_per_million_usd,output_cost_per_million_usd,updated_at`,[model.trim(),Number(inputCost),Number(outputCost)]); res.json({settings:result.rows[0]}); }
  catch(error){console.error('AI dashboard settings failed:',error.message);res.status(500).json({error:'Could not update AI settings'});}
});

function suggestIngredientLocally(ingredient = {}) {
  const sourceName = String(ingredient.name || '').trim();
  const sourceUnit = String(ingredient.unit || '').trim();
  const combined = `${sourceUnit} ${sourceName}`.toLowerCase();
  const aliases = { 'vispgrädde':'whipping cream', 'matlagningsgrädde':'cooking cream', 'purjolök':'leek', 'potatis':'potato', 'grönsaksbuljong':'vegetable bouillon', 'peppar':'black pepper', 'torkad timjan':'thyme, dried', 'rapsolja':'rapeseed oil', 'olja':'oil', 'persilja':'parsley', 'bröd':'bread' };
  const normalizedName = aliases[sourceName.toLowerCase()] || sourceName;
  const context = String(ingredient.context || '').toLowerCase();
  const searchQuery = normalizedName === 'potato' && /(koka|kokt|boil|simmer)/.test(context) ? 'potato boiled' : normalizedName;
  const statedGrams = combined.match(/(?:ca|cirka|about)?\s*(\d+(?:[.,]\d+)?)\s*g\b/i);
  const amount = numberOrNull(ingredient.amount);
  const householdUnit = /^(st|styck|piece|purjolök)$/i.test(sourceUnit) || /purjolök.*\bg\)/i.test(sourceUnit) ? 'piece' : sourceUnit;
  return { search_query:searchQuery, normalized_name:normalizedName, amount, unit:householdUnit, amount_grams:statedGrams ? numberOrNull(statedGrams[1]) : numberOrNull(ingredient.amount_grams), confidence: aliases[sourceName.toLowerCase()] ? 0.78 : 0.35, source:'local' };
}

app.post('/api/ingredient-match/suggest', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const ingredient = req.body?.ingredient || {};
  const suggestion = suggestIngredientLocally(ingredient);
  const query = suggestion.search_query;
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!tokens.length) return res.json({ suggestion, foods:[], suggested_food_id:null });
  try {
    const result = await pool.query(`SELECT id, COALESCE(display_name,name) AS name, state, fineli_food_id FROM foods WHERE status='verified' AND basis_amount=100 AND basis_unit='g' AND fineli_food_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS token WHERE COALESCE(name,'') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)') AND COALESCE(name_sv,'') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)') AND COALESCE(name_fi,'') !~* ('(^|[^[:alnum:]])' || token || '([^[:alnum:]]|$)')) ORDER BY CASE WHEN lower(name)=lower($2) THEN 0 WHEN lower(name) LIKE lower($2) || ',%' THEN 1 ELSE 2 END, length(COALESCE(display_name,name)), name LIMIT 20`, [tokens, query]);
    res.json({ suggestion, foods:result.rows, suggested_food_id:result.rows[0]?.id || null });
  } catch (error) { console.error('Ingredient suggestion failed:', error.message); res.status(500).json({ error:'Could not suggest a food match' }); }
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
        ['energy_kcal','kcal'],['prot','protein_g'],['fat','fat_g'],['choavl','carbohydrate_g'],['fibc','fiber_g'],['ca','calcium_mg'],['fe','iron_mg'],['zn','zinc_mg'],['vitc','vitamin_c_mg'],['fol','folate_ug'],['vitb12','vitamin_b12_ug'],['vitd','vitamin_d_ug']
      ].map(([code,key]) => ({code,value:snapshot[key],supporting_ingredients:1}));
      for (const nutrient of nutrients) if (nutrient.value != null) { const code = nutrient.code === 'enerc' ? 'energy_kcal' : nutrient.code; const target=DISPLAY_NUTRIENTS.find(([candidate])=>candidate===code); if(!target) continue; sums[code] += Number(nutrient.value); available[code] = true; sourceIngredients[code] += Number(nutrient.supporting_ingredients || 1); }
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
  const result = await pool.query(`SELECT r.id, r.name, r.description, r.instructions, r.servings, r.image_url, CASE WHEN r.image_data IS NOT NULL THEN 'data:'||r.image_mime||';base64,'||encode(r.image_data,'base64') ELSE NULL END AS image_data_uri, COALESCE(json_agg(json_build_object('name',ri.ingredient_name,'amount',ri.amount,'unit',ri.unit,'amount_grams',ri.amount_grams,'original_amount',ri.original_amount,'original_unit',ri.original_unit,'food_id',ri.food_id,'state',f.state,'source_name',f.source_name,'fineli_food_id',f.fineli_food_id) ORDER BY ri.sort_order) FILTER (WHERE ri.id IS NOT NULL), '[]') AS ingredients FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id=r.id LEFT JOIN foods f ON f.id=ri.food_id GROUP BY r.id ORDER BY r.name`);
  res.json({ recipes: result.rows });
});

app.get('/api/recipes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query(`SELECT r.id, r.name, r.description, r.instructions, r.servings, r.image_url, CASE WHEN r.image_data IS NOT NULL THEN 'data:'||r.image_mime||';base64,'||encode(r.image_data,'base64') ELSE NULL END AS image_data_uri, COALESCE(json_agg(json_build_object('name',ri.ingredient_name,'amount',ri.amount,'unit',ri.unit,'amount_grams',ri.amount_grams,'original_amount',ri.original_amount,'original_unit',ri.original_unit,'food_id',ri.food_id,'state',f.state,'source_name',f.source_name,'fineli_food_id',f.fineli_food_id) ORDER BY ri.sort_order) FILTER (WHERE ri.id IS NOT NULL), '[]') AS ingredients FROM recipes r LEFT JOIN recipe_ingredients ri ON ri.recipe_id=r.id LEFT JOIN foods f ON f.id=ri.food_id WHERE r.id=$1 GROUP BY r.id`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Recipe not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Recipe query failed:', error.message);
    res.status(500).json({ error: 'Could not load recipe' });
  }
});

app.get('/api/recipes-delete-status', async (_req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  try {
    const result = await pool.query(`SELECT r.id, r.name, COUNT(re.entry_id)::int AS logged_entry_count FROM recipes r LEFT JOIN recipe_entries re ON re.recipe_id=r.id GROUP BY r.id ORDER BY r.name`);
    res.json({ recipes: result.rows });
  } catch (error) { console.error('Recipe delete status failed:', error.message); res.status(500).json({ error: 'Could not read recipe delete status' }); }
});

app.put('/api/recipes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { name, instructions, image_url: imageUrl = null, ingredients = [] } = req.body;
  if (typeof instructions !== 'string' || typeof name !== 'string') return res.status(400).json({ error: 'name and instructions are required' });
  // Legacy recipes can contain text imported before UTF-8 handling was fixed.
  // Do not block their nutrition links or edits; the editor preserves the text
  // exactly and any corrected user input is stored as UTF-8.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storedImage=await downloadRecipeImage(imageUrl);const result = await client.query('UPDATE recipes SET name=$1,instructions=$2,image_url=$3,image_data=$4,image_mime=$5 WHERE id=$6 RETURNING id,name,instructions,image_url', [name.trim(), instructions.trim(), imageUrl, storedImage.data, storedImage.mime, req.params.id]);
    if (!result.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Recipe not found' }); }
    await client.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [req.params.id]);
    for (const [index, item] of ingredients.entries()) {
      const amount = numberOrNull(item.amount); const unit = String(item.unit || item.original_unit || 'g').trim(); const amountGrams = item.amount_grams == null || item.amount_grams === '' ? safeGramAmount(amount, unit, item.grams_per_unit) : numberOrNull(item.amount_grams);
      const originalAmount = numberOrNull(item.original_amount);
      /* Only retain a food id when it is a verified Fineli 100 g record. */
      const food = await client.query("SELECT id FROM foods WHERE id=$1 AND status='verified' AND fineli_food_id IS NOT NULL AND basis_amount=100 AND basis_unit='g'", [item.food_id || null]);
      await client.query('INSERT INTO recipe_ingredients(recipe_id,ingredient_name,amount,unit,original_amount,original_unit,amount_grams,food_id,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [req.params.id, String(item.name || '').trim(), amount, unit, originalAmount == null ? amount : originalAmount, item.original_unit || unit, amountGrams, food.rows[0]?.id || null, index]);
    }
    await client.query('COMMIT'); res.json({ recipe: result.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); console.error('Recipe update failed:', error.message); res.status(500).json({ error: 'Could not update recipe' }); }
  finally { client.release(); }
});

app.delete('/api/recipes/:id', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM recipe_entries re WHERE re.recipe_id=$1 AND NOT EXISTS (SELECT 1 FROM food_entries fe WHERE fe.id=re.entry_id)', [req.params.id]);
    const linked = await client.query('SELECT 1 FROM recipe_entries WHERE recipe_id=$1 LIMIT 1', [req.params.id]);
    if (linked.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Recipe has logged food entries and cannot be deleted.' }); }
    const deleted = await client.query('DELETE FROM recipes WHERE id=$1 RETURNING id', [req.params.id]);
    if (!deleted.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Recipe not found' }); }
    await client.query('COMMIT');
    res.json({ deleted: true, id: req.params.id });
  } catch (error) { await client.query('ROLLBACK'); console.error('Recipe delete failed:', error.message); res.status(500).json({ error: 'Could not delete recipe' }); }
  finally { client.release(); }
});

app.post('/api/recipes/:id/log', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });
  const { user_id: userId, eaten_at: eatenAt, note = null } = req.body;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  try {
    const recipe = await pool.query('SELECT name FROM recipes WHERE id=$1', [req.params.id]);
    if (!recipe.rows[0]) return res.status(404).json({ error: 'Recipe not found' });
    const ingredients = await pool.query(`SELECT ri.ingredient_name AS name, ri.amount, ri.unit, ri.amount_grams, ri.original_amount, ri.original_unit, ri.food_id, ri.preparation_state, f.state AS food_state, f.basis_amount, f.basis_unit, f.source_name, f.source_id FROM recipe_ingredients ri LEFT JOIN foods f ON f.id=ri.food_id WHERE ri.recipe_id=$1 ORDER BY ri.sort_order`, [req.params.id]);
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
      amount_grams: item.amount_grams === null || item.amount_grams === '' || item.amount_grams == null ? safeGramAmount(item.amount, item.unit, item.grams_per_unit) : Number(item.amount_grams),
      original_amount: item.original_amount == null ? (item.amount === null || item.amount === '' ? null : Number(item.amount)) : Number(item.original_amount),
      original_unit: typeof item.original_unit === 'string' ? item.original_unit : (typeof item.unit === 'string' ? item.unit : 'g'),
      preparation_state: ['raw', 'cooked', 'dry', 'powdered', 'frozen', 'fortified', 'volume', 'unresolved'].includes(item.preparation_state) ? item.preparation_state : 'unresolved'
    }));
    if (normalizedIngredients.some((item) => !Number.isFinite(item.amount) && item.amount !== null)) return res.status(400).json({ error: 'Ingredient amounts must be numbers or explicitly missing' });
    const safeIngredients = await verifiedFineliIngredients(pool, normalizedIngredients);
    if (update_standard) {
      if (safeIngredients.some((item) => item.amount === null || item.amount <= 0)) return res.status(400).json({ error: 'Standard recipes require a positive amount for every ingredient; keep unknown amounts in the day instance instead' });
      await pool.query('DELETE FROM recipe_ingredients WHERE recipe_id=$1', [recipeId]);
      for (const [i, item] of safeIngredients.entries()) await pool.query('INSERT INTO recipe_ingredients (recipe_id, ingredient_name, amount, unit, original_amount, original_unit, amount_grams, food_id, preparation_state, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [recipeId, item.name, item.amount, item.unit, item.original_amount, item.original_unit, item.amount_grams, item.food_id || null, item.preparation_state, i]);
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
  const client = await pool.connect();
  try {
    const filenames = ['002_normalized_nutrition.sql', '003_import_fineli_verified_foods.sql', '005_link_recipe_ingredients_fineli.sql', '006_recipe_snapshot_nutrition.sql', '007_restore_verified_spinach.sql', '008_unlink_ambiguous_seed_tofu.sql', '009_fineli_import_staging.sql', '010_explicit_recipe_preparation_state.sql', '011_recipe_image.sql', '012_recipe_image_data.sql', '013_recipe_original_units.sql', '014_fineli_catalog_import_runs.sql', '015_allow_unresolved_recipe_amounts.sql', '016_store_recipe_images_locally.sql', '017_retire_legacy_food_catalog.sql', '018_nutrition_data_repair.sql', '020_ai_usage_dashboard.sql', '021_magic_link_auth.sql'];
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    // Older deployments predate migration tracking. The presence of the last pre-repair
    // table is their durable application record, so baseline them instead of replaying.
    const legacyApplied = (await client.query(`SELECT to_regclass('public.nutrition_catalog_import_runs') IS NOT NULL AS applied`)).rows[0].applied;
    if (legacyApplied) await client.query(`INSERT INTO schema_migrations(filename) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [filenames.slice(0, -1)]);
    for (const filename of filenames) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename])).rowCount) continue;
      const sql = await fs.readFile(path.join(process.cwd(), 'migrations', filename), 'utf8');
      await client.query('BEGIN');
      try { await client.query(sql); await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]); await client.query('COMMIT'); }
      catch (error) { await client.query('ROLLBACK'); throw new Error(`${filename}: ${error.message}`); }
    }
    console.log('Fineli nutrition migrations applied');
    // Full Fineli import is intentionally not run at API startup. It must run in resumable batches.
  } finally { client.release(); }
}

applyNutritionMigrations()
  .then(() => app.listen(port, () => console.log(`Living on Plants API listening on port ${port}`)))
  .catch((error) => { console.error('Nutrition migration failed:', error.message); process.exit(1); });
