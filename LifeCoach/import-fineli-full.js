import fs from 'node:fs/promises';
import path from 'node:path';

const DATA = path.join(process.cwd(), 'data', 'fineli');
const parse = async (file) => {
  const text = await fs.readFile(path.join(DATA, file), 'latin1');
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const fields = head.split(';');
  return rows.map(row => Object.fromEntries(fields.map((field, i) => [field, row.split(';')[i] ?? ''])));
};
const clean = v => String(v || '').trim();
const number = v => Number(String(v).replace(',', '.'));

export async function importFullFineli(pool, { offset = 0, limit = 25 } = {}) {
  const existing = await pool.query("SELECT count(*)::int AS n FROM foods WHERE source_name LIKE 'Fineli%'");
  if (existing.rows[0].n >= 4232) return { skipped: true, foods: existing.rows[0].n };

  await pool.query(`ALTER TABLE foods ADD COLUMN IF NOT EXISTS fineli_food_id INTEGER UNIQUE;
    ALTER TABLE foods ADD COLUMN IF NOT EXISTS name_sv TEXT;
    ALTER TABLE foods ADD COLUMN IF NOT EXISTS name_fi TEXT;`);
  const [foods, en, sv, fi, components, values] = await Promise.all([
    parse('food.csv'), parse('foodname_EN.csv'), parse('foodname_SV.csv'), parse('foodname_FI.csv'), parse('component.csv'), parse('component_value.csv')
  ]);
  const names = new Map();
  for (const row of en) names.set(row.FOODID, { en: clean(row.FOODNAME) });
  for (const row of sv) if (names.has(row.FOODID)) names.get(row.FOODID).sv = clean(row.FOODNAME);
  for (const row of fi) if (names.has(row.FOODID)) names.get(row.FOODID).fi = clean(row.FOODNAME);
  const componentMap = new Map(components.map(c => [c.EUFDNAME, c.COMPUNIT]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selectedFoods = foods.slice(offset, offset + limit);
    const selectedIds = new Set(selectedFoods.map(f => f.FOODID));
    for (let offset = 0; offset < selectedFoods.length; offset += 300) {
      const batch = selectedFoods.slice(offset, offset + 300).filter(f => names.get(f.FOODID)?.en);
      const valuesSql = [], args = [];
      for (const f of batch) { const n = names.get(f.FOODID); const i = args.length; args.push(Number(f.FOODID), n.en, n.sv || null, n.fi || null, f.PROCESS || 'unknown'); valuesSql.push(`($${i+1},$${i+2},$${i+3},$${i+4},$${i+5},100,'g','Fineli / Finnish Institute for Health and Welfare','Fineli','verified')`); }
      await client.query(`INSERT INTO foods (fineli_food_id,name,name_sv,name_fi,state,basis_amount,basis_unit,source_name,source_id,status) VALUES ${valuesSql.join(',')} ON CONFLICT (fineli_food_id) DO UPDATE SET name=EXCLUDED.name,name_sv=EXCLUDED.name_sv,name_fi=EXCLUDED.name_fi,state=EXCLUDED.state,status='verified'`, args);
    }
    for (const [code, unit] of componentMap) await client.query(`INSERT INTO nutrients (code,name,unit,category) VALUES ($1,$1,$2,'fineli') ON CONFLICT (code) DO NOTHING`, [code.toLowerCase(), unit]);
    for (let offset = 0; offset < values.length; offset += 1000) {
      const batch = values.slice(offset, offset + 1000).filter(v => selectedIds.has(v.FOODID) && names.has(v.FOODID) && componentMap.has(v.EUFDNAME) && Number.isFinite(number(v.BESTLOC)));
      const sql = [], args = [];
      for (const v of batch) { const i=args.length; args.push(Number(v.FOODID), v.EUFDNAME.toLowerCase(), number(v.BESTLOC)); sql.push(`($${i+1},$${i+2},$${i+3})`); }
      if (sql.length) await client.query(`INSERT INTO food_nutrients (food_id,nutrient_id,value,source_name,source_id) SELECT f.id,n.id,x.value::numeric,'Fineli / Finnish Institute for Health and Welfare',f.fineli_food_id::text FROM (VALUES ${sql.join(',')}) AS x(fineli_food_id,code,value) JOIN foods f ON f.fineli_food_id=x.fineli_food_id::integer JOIN nutrients n ON n.code=x.code ON CONFLICT (food_id,nutrient_id) DO UPDATE SET value=EXCLUDED.value,source_name=EXCLUDED.source_name,source_id=EXCLUDED.source_id`, args);
    }
    await client.query('COMMIT');
    return { skipped: false, importedFoods: selectedFoods.length, offset, nutrientValues: values.filter(v => selectedIds.has(v.FOODID)).length };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
