// Rebuild the monthly sea breeze history from every reading in harbor_conditions
// and write app/climatology.json, which the page loads in place of the built-in table.
// Run nightly by .github/workflows/climatology.yml. `--dry-run` prints without writing.
import { writeFile } from 'node:fs/promises';
import { cleanRows, bin10, nzParts, buildClimatology } from './logic.js';

const SUPABASE_URL = 'https://sffjznjsxcnhetmiipui.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-XGKiGcqbPJP7G-W_6VdlQ_ScHG37Pu'; // read-only, same as the page
const PAGE = 1000;

async function fetchAll() {
  const rows = [];
  let after = '1970-01-01T00:00:00Z';
  for (;;) {
    const url = `${SUPABASE_URL}/rest/v1/harbor_conditions?select=created_at,image_update,fairway_wind,fairway_dir,main_wharf_wind,main_wharf_dir`
      + `&created_at=gt.${encodeURIComponent(after)}&order=created_at.asc&limit=${PAGE}`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_KEY } });
    if (!res.ok) throw new Error(`Supabase request failed (${res.status}): ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page.at(-1).created_at;
  }
}

const rows = cleanRows(await fetchAll());
const today = nzParts(Date.now());
const byDay = new Map();
for (const r of rows) {
  const p = nzParts(Date.parse(r.created_at));
  if (p.year === today.year && p.month === today.month && p.day === today.day) continue; // today is not over yet
  const k = `${p.year}-${p.month}-${p.day}`;
  if (!byDay.has(k)) byDay.set(k, { month: p.month, rows: [] });
  byDay.get(k).rows.push(r);
}
const days = [...byDay.values()].map(d => ({ month: d.month, bins: bin10(d.rows) }));
const months = buildClimatology(days);

const out = {
  updated: new Date().toISOString(),
  readings: rows.length, days: days.length,
  from: rows[0]?.created_at, to: rows.at(-1)?.created_at,
  months,
};
console.log(JSON.stringify(out, null, 2));
if (!Object.keys(months).length) throw new Error('No month had enough days; keeping the existing file.');
if (!process.argv.includes('--dry-run')) {
  await writeFile(new URL('./climatology.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
}
