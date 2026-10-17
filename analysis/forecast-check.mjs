// One-off check: would Open-Meteo forecasts have predicted the sea breeze better
// than the month-by-month history? Prints a summary; writes nothing.
import { cleanRows, bin10, nzParts, morningMean, findSettled, GRADIENT_KN, CLIMATOLOGY, ONSHORE_AXIS } from '../app/logic.js';

const SUPABASE_URL = 'https://sffjznjsxcnhetmiipui.supabase.co';
const SUPABASE_KEY = 'sb_publishable_-XGKiGcqbPJP7G-W_6VdlQ_ScHG37Pu';
const get = async url => { const r = await fetch(url, { headers: url.includes('supabase') ? { apikey: SUPABASE_KEY } : {} }); if (!r.ok) throw new Error(`${r.status} ${url}: ${await r.text()}`); return r.json(); };

let rows = [], after = '1970-01-01T00:00:00Z';
for (;;) {
  const page = await get(`${SUPABASE_URL}/rest/v1/harbor_conditions?select=created_at,image_update,fairway_wind,fairway_dir,main_wharf_wind,main_wharf_dir&created_at=gt.${encodeURIComponent(after)}&order=created_at.asc&limit=1000`);
  rows.push(...page); if (page.length < 1000) break; after = page.at(-1).created_at;
}
rows = cleanRows(rows);
const pad = n => String(n).padStart(2, '0');
const byDay = new Map();
for (const r of rows) {
  const p = nzParts(Date.parse(r.created_at)); const k = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r);
}
const today = (() => { const p = nzParts(Date.now()); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; })();
const days = [];
for (const [date, rs] of byDay) {
  if (date >= today) continue;
  const bins = bin10(rs);
  if (bins.filter(b => b.minutes >= 540 && b.minutes < 960 && b.fw != null).length < 30) continue;
  const morning = morningMean(bins); if (morning == null) continue;
  const i = findSettled(bins);
  days.push({ date, month: +date.slice(5, 7), morning, arrive: i >= 0 ? bins[i].minutes : null });
}
const dates = days.map(d => d.date).sort();
const start = dates[0], end = dates.at(-1);

// Forecasts: inland (Waimea plains) for heating, cloud and gradient wind; Tasman Bay for sea temperature.
const om = await get(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=-41.38&longitude=173.12&start_date=${start}&end_date=${end}`
  + `&hourly=temperature_2m,cloud_cover,shortwave_radiation,wind_speed_10m,wind_direction_10m,pressure_msl&daily=temperature_2m_max,sunshine_duration&wind_speed_unit=kn&timezone=Pacific%2FAuckland`);
let sst = null;
try {
  sst = await get(`https://marine-api.open-meteo.com/v1/marine?latitude=-41.15&longitude=173.30&start_date=${start}&end_date=${end}&hourly=sea_surface_temperature&timezone=Pacific%2FAuckland`);
} catch (e) { console.log('Sea temperature unavailable:', e.message.slice(0, 200)); }

const H = om.hourly, idx = new Map(H.time.map((t, i) => [t, i]));
const hours = (date, from, to, key) => { const v = []; for (let h = from; h < to; h++) { const i = idx.get(`${date}T${pad(h)}:00`); if (i != null && H[key][i] != null) v.push(H[key][i]); } return v; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sstDay = new Map();
if (sst) sst.hourly.time.forEach((t, i) => { const d = t.slice(0, 10); if (sst.hourly.sea_surface_temperature[i] != null) { if (!sstDay.has(d)) sstDay.set(d, []); sstDay.get(d).push(sst.hourly.sea_surface_temperature[i]); } });

for (const d of days) {
  const di = om.daily.time.indexOf(d.date);
  d.tmax = om.daily.temperature_2m_max[di];
  d.sun = om.daily.sunshine_duration[di] / 3600;
  d.cloudAM = mean(hours(d.date, 8, 13, 'cloud_cover'));
  d.solarAM = mean(hours(d.date, 8, 13, 'shortwave_radiation'));
  const sp = hours(d.date, 9, 13, 'wind_speed_10m'), dr = hours(d.date, 9, 13, 'wind_direction_10m');
  d.gradKn = mean(sp);
  d.gradOnshore = mean(sp.map((s, i) => s * Math.cos((dr[i] - ONSHORE_AXIS) * Math.PI / 180))); // + onshore, - offshore
  d.sst = sstDay.has(d.date) ? mean(sstDay.get(d.date)) : null;
  d.landSea = d.sst != null && d.tmax != null ? d.tmax - d.sst : null;
  d.light = d.morning < GRADIENT_KN;
  d.by13 = d.arrive != null && d.arrive <= 780 ? 1 : 0;
  d.any = d.arrive != null ? 1 : 0;
}

const light = days.filter(d => d.light);
console.log(`Days ${days.length} (${start} to ${end}); light mornings ${light.length}; breeze by 13:00 on ${light.filter(d => d.by13).length}`);
const feats = ['tmax', 'landSea', 'sun', 'cloudAM', 'solarAM', 'gradKn', 'gradOnshore', 'morning'];
const corr = (xs, ys) => { const n = xs.length, mx = mean(xs), my = mean(ys); let a = 0, b = 0, c = 0; for (let i = 0; i < n; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; } return a / Math.sqrt(b * c); };
console.log('\nCorrelation on light mornings (r): with breeze by 13:00 | with any breeze | with arrival time (breeze days)');
for (const f of feats) {
  const ok = light.filter(d => d[f] != null);
  const br = ok.filter(d => d.arrive != null);
  console.log(`${f.padEnd(12)} n=${ok.length}  ${corr(ok.map(d => d[f]), ok.map(d => d.by13)).toFixed(2)} | ${corr(ok.map(d => d[f]), ok.map(d => d.any)).toFixed(2)} | ${br.length > 5 ? corr(br.map(d => d[f]), br.map(d => d.arrive)).toFixed(2) : '-'}`);
}

// Leave-one-out: logistic regression on forecast features vs month history, Brier score for "breeze by 13:00".
function fitPredict(train, test, fs) {
  const mu = fs.map(f => mean(train.map(d => d[f]))), sd = fs.map((f, j) => Math.sqrt(mean(train.map(d => (d[f] - mu[j]) ** 2))) || 1);
  const x = d => [1, ...fs.map((f, j) => (d[f] - mu[j]) / sd[j])];
  let w = Array(fs.length + 1).fill(0);
  for (let it = 0; it < 2000; it++) {
    const g = w.map(() => 0);
    for (const d of train) { const xi = x(d), p = 1 / (1 + Math.exp(-xi.reduce((s, v, k) => s + v * w[k], 0))); xi.forEach((v, k) => g[k] += (p - d.by13) * v); }
    w = w.map((v, k) => v - 0.05 * (g[k] / train.length + (k ? 0.05 * v : 0)));
  }
  const xi = x(test); return 1 / (1 + Math.exp(-xi.reduce((s, v, k) => s + v * w[k], 0)));
}
const brier = ps => mean(ps.map(([p, y]) => (p - y) ** 2));
const monthRate = (train, d) => { const m = train.filter(t => t.month === d.month); return m.length ? mean(m.map(t => t.by13)) : mean(train.map(t => t.by13)); };
const sets = [['tmax', 'cloudAM', 'gradOnshore'], ['sun', 'gradOnshore'], ['tmax', 'cloudAM', 'gradOnshore', 'gradKn'], ['landSea', 'cloudAM', 'gradOnshore']];
console.log('\nLeave-one-out Brier score for "breeze by 13:00" on light mornings (lower is better)');
const base = light.map(d => [monthRate(light.filter(t => t !== d), d), d.by13]);
console.log(`month history only      ${brier(base).toFixed(3)}`);
for (const fs of sets) {
  const ok = light.filter(d => fs.every(f => d[f] != null)); if (ok.length < 20) { console.log(`${fs.join('+')}: too few days`); continue; }
  const withMonth = ok.map(d => { const tr = ok.filter(t => t !== d); return [fitPredict(tr.map(t => ({ ...t, mrate: monthRate(tr, t) })), { ...d, mrate: monthRate(tr, d) }, [...fs, 'mrate']), d.by13]; });
  const bm = ok.map(d => [monthRate(ok.filter(t => t !== d), d), d.by13]);
  console.log(`${(fs.join('+') + ' + month').padEnd(40)} ${brier(withMonth).toFixed(3)}  (month only on same ${ok.length} days ${brier(bm).toFixed(3)})`);
}

console.log('\nBy forecast group (light mornings): share with breeze by 13:00, median arrival');
const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const fm = m => m == null ? '-' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
for (const [name, f] of [['cloud 08-13 (%)', 'cloudAM'], ['gradient onshore kn', 'gradOnshore'], ['inland max temp', 'tmax'], ['land minus sea', 'landSea']]) {
  const ok = light.filter(d => d[f] != null).sort((a, b) => a[f] - b[f]); if (ok.length < 9) continue;
  const t = Math.floor(ok.length / 3);
  for (const [lab, g] of [['low', ok.slice(0, t)], ['mid', ok.slice(t, 2 * t)], ['high', ok.slice(2 * t)]])
    console.log(`${name.padEnd(22)} ${lab.padEnd(5)} ${g[0][f].toFixed(1)}..${g.at(-1)[f].toFixed(1)}  n=${g.length}  by13 ${(mean(g.map(d => d.by13)) * 100).toFixed(0)}%  median arrival ${fm(med(g.map(d => d.arrive)))}`);
}
console.log('\nCSV');
console.log(['date', 'morning', 'arrive', ...feats.filter(f => f !== 'morning')].join(','));
for (const d of days) console.log([d.date, d.morning.toFixed(1), d.arrive ?? '', ...feats.filter(f => f !== 'morning').map(f => d[f] == null ? '' : d[f].toFixed(2))].join(','));
