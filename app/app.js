import {
  cleanRows, bin10, evaluate, nzParts, fmtMinutes, fmtDDM, POLARS, beatLength, raceWind, TARGET_MINUTES, toMagnetic, MAG_VARIATION_E, COURSE_AREAS, isOnshore, setClimatology,
  summariseForecast, forecastHint, noBreezeWarning, FORECAST_INLAND, FORECAST_SEA,
} from './logic.js';

const SUPABASE_URL = 'https://sffjznjsxcnhetmiipui.supabase.co';
// Publishable key: read-only access to harbor_conditions, safe to ship in a web page.
const SUPABASE_KEY = 'sb_publishable_-XGKiGcqbPJP7G-W_6VdlQ_ScHG37Pu';
const REFRESH_MS = 2 * 60 * 1000;

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let lastStatus = null, gps = null, bins = [];

function todayKey() {
  const p = nzParts(Date.now());
  return `taps-${p.year}-${p.month}-${p.day}`;
}
const getTaps = () => store.get(todayKey(), []);

async function fetchRows() {
  // From 05:00 NZ time today (or the last 8 hours, whichever is longer).
  const since = new Date(Date.now() - Math.max(8 * 3600e3, (nzParts(Date.now()).minutes - 300) * 60e3));
  const url = `${SUPABASE_URL}/rest/v1/harbor_conditions?select=created_at,image_update,fairway_wind,fairway_dir,main_wharf_wind,main_wharf_dir`
    + `&created_at=gte.${since.toISOString()}&order=created_at.asc`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY } });
  if (!res.ok) throw new Error(`Harbour data request failed (${res.status})`);
  return res.json();
}

function settings() {
  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  return {
    area: $('area').value, gradient: $('mode').value === 'gradient', veer: num('veer', 8), lay: num('lay', 15), seq: num('seq', 5),
    sigOuter: +$('sigOuter').value, sigInner: +$('sigInner').value,
    pctOuter: num('pctOuter', 100), pctInner: num('pctInner', 100),
  };
}

function render() {
  const s = settings();
  const r = evaluate(bins, { nowMs: Date.now(), taps: getTaps(), veer: s.veer, layMinutes: s.lay, sequenceMinutes: s.seq, gradientRace: s.gradient });

  $('status').textContent = r.status;
  $('status').className = `status ${r.status.split(' ')[0]}`;
  $('detail').textContent = r.detail;

  const early = !s.gradient && (r.status === 'Waiting' || r.status === 'Building' || r.status === 'Gradient wind');
  const noBreeze = early ? noBreezeWarning(forecast, r.morning) : null;
  const hint = forecast && !noBreeze && !s.gradient && r.status !== 'Settled' && r.status !== 'Unsettled' ? forecastHint(forecast) : null;
  const L = bins.at(-1);
  const d3 = d => String(Math.round(d)).padStart(3, '0');
  const stn = (kn, dir) => kn == null || dir == null ? 'no reading' : `${kn.toFixed(0)} kn from ${d3(dir)}°T${isOnshore(dir) ? '' : ', offshore'}`;
  $('now').textContent = L ? `Now: Fairway ${stn(L.fw, L.fd)}. Main Wharf ${stn(L.mw, L.md)}.` : '';
  $('forecast').hidden = !hint;
  $('forecast').textContent = hint?.text ?? '';

  const advice = [noBreeze, r.postpone].filter(Boolean).join(' ');
  $('postpone').hidden = !advice;
  $('postpone').textContent = advice;

  if (r.window) {
    $('windowLabel').textContent = 'Expected arrival';
    $('window').textContent = `${fmtMinutes(r.window.lo)}–${fmtMinutes(r.window.hi)}`;
    $('windowNote').textContent = r.window.fromHistory
      ? `From ${r.clim.days} ${monthName(r.clim.month)} mornings${r.clim.fallback ? ' (nearest month with enough data)' : ''}. Most likely about ${fmtMinutes(r.window.typical)}.`
      : `Most likely about ${fmtMinutes(r.window.typical)}.`;
  } else {
    $('windowLabel').textContent = 'Breeze arrived';
    $('window').textContent = r.settledAt != null ? fmtMinutes(r.settledAt) : '–';
    $('windowNote').textContent = s.gradient ? 'Sea breeze timing is off while racing in the gradient wind.' : '4 kn or more onshore for 30 minutes at the Fairway.';
  }

  if (r.start) {
    $('start').textContent = fmtMinutes(r.start.start);
    $('startNote').textContent = `Warning signal ${fmtMinutes(r.start.warning)}${r.start.provisional ? '. Provisional until the breeze settles.' : '.'}`;
  } else {
    $('start').textContent = '–';
    $('startNote').textContent = s.gradient ? 'Wait for 30 minutes of 4 kn or more.' : 'Wait for a steady breeze.';
  }

  const deg3 = d => String(d).padStart(3, '0');
  const axis = deg3(toMagnetic(r.bearing.bearing));
  $('bearing').textContent = `${axis}°M`;
  $('bearing').dataset.copy = axis;
  $('bearingTrue').textContent = `${deg3(r.bearing.bearing)}°T, variation ${MAG_VARIATION_E}° E`;
  const wind = raceWind(bins, { onshoreOnly: !s.gradient });
  const m1 = beatLength(POLARS.j111, wind.kn, s.sigOuter, { speedFactor: s.pctOuter / 100 }).nm.toFixed(2);
  const m1a = beatLength(POLARS.e59, wind.kn, s.sigInner, { speedFactor: s.pctInner / 100 }).nm.toFixed(2);
  $('mark1').textContent = `${m1} nm`; $('mark1').dataset.copy = m1;
  $('mark1a').textContent = `${m1a} nm`; $('mark1a').dataset.copy = m1a;
  $('sizeNote').textContent = `Sized for a ${TARGET_MINUTES}-minute race for the leading boat: J/111 on signal ${s.sigOuter}, Elliott 5.9 on signal ${s.sigInner}, `
    + (wind.source === 'live' ? `in the ${wind.kn.toFixed(0)} kn now at the Fairway.` : s.gradient ? `in a typical ${wind.kn} kn until the wind fills in.` : `in a typical ${wind.kn} kn sea breeze until the breeze arrives.`);
  $('bearingNote').textContent = r.bearing.source === 'live'
    ? `Fairway direction over the last 30 minutes plus ${s.veer}° for the usual veer, give or take ${r.bearing.spread}°.`
    : r.bearing.source === 'gradient'
    ? `Fairway direction over the last 30 minutes, give or take ${r.bearing.spread}°. No veer added in a gradient wind.`
    : 'Expected sea breeze axis from history (usually about 355°T), not the wind blowing now. Updates when the breeze settles.';

  const origin = s.area === 'gps' ? gps : COURSE_AREAS[s.area];
  if (origin) {
    const lat = fmtDDM(origin.lat, true), lon = fmtDDM(origin.lon, false);
    $('mark').innerHTML = `<button class="copy" data-copy="${lat}">${lat}</button><br><button class="copy" data-copy="${lon}">${lon}</button>`
      + `<div class="muted">${s.area === 'gps' ? 'Your position' : COURSE_AREAS[s.area].name}</div>`;
  } else {
    $('mark').innerHTML = '<span class="muted">Waiting for your position…</span>';
  }

  if (lastStatus && r.status === 'Arriving' && lastStatus !== 'Arriving') navigator.vibrate?.([300, 150, 300]);
  if (lastStatus && r.status === 'Settled' && lastStatus !== 'Settled') navigator.vibrate?.([600]);
  lastStatus = r.status;

  drawChart();
  renderLog();
}

const monthName = m => new Date(2026, m - 1, 1).toLocaleString('en-NZ', { month: 'long' });

function drawChart() {
  const svg = $('chart');
  const recent = bins.slice(-18);
  if (!recent.length) { svg.innerHTML = '<text x="10" y="20">No data yet today</text>'; return; }
  const W = 520, top = 10, bottom = 120, left = 28, right = 510;
  const max = Math.max(10, ...recent.flatMap(b => [b.fw ?? 0, b.mw ?? 0]));
  const x = i => left + (i + 0.5) * (right - left) / 18;
  const y = v => bottom - (v / max) * (bottom - top);
  const line = key => recent.map((b, i) => b[key] == null ? null : `${x(i)},${y(b[key])}`).filter(Boolean).join(' ');
  const grid = [0, Math.round(max / 2), Math.round(max)].map(v =>
    `<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="2" y="${y(v) + 4}">${v}</text>`).join('');
  const four = `<line x1="${left}" x2="${right}" y1="${y(4)}" y2="${y(4)}" stroke="var(--good)" stroke-dasharray="4 4"/><text x="${right - 30}" y="${y(4) - 4}">4 kn</text>`;
  const ticks = recent.map((b, i) => {
    if (b.fd == null) return '';
    const to = (b.fd + 180) * Math.PI / 180, cx = x(i), cy = 145, L = 10;
    const x2 = cx + L * Math.sin(to), y2 = cy - L * Math.cos(to);
    return `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="${isOnshore(b.fd) ? 'var(--accent)' : 'var(--muted)'}" stroke-width="2.5" stroke-linecap="round"/>`;
  }).join('');
  const labels = recent.map((b, i) => i % 3 === 0 ? `<text x="${x(i)}" y="168" text-anchor="middle">${fmtMinutes(b.minutes)}</text>` : '').join('');
  svg.innerHTML = grid + four
    + `<polyline points="${line('mw')}" fill="none" stroke="var(--muted)" stroke-width="2"/>`
    + `<polyline points="${line('fw')}" fill="none" stroke="var(--accent)" stroke-width="3"/>`
    + ticks + labels;
  svg.setAttribute('viewBox', `0 0 ${W} 172`);
}

const TAP_NAMES = {
  'wind-on-water': 'Wind on water to the north', plume: 'Plume leaning south', cloud: 'Cloud building',
  'breeze-in': 'Breeze is in (race officer)', 'mark-laid': 'Windward mark laid',
};

function renderLog() {
  const taps = getTaps();
  $('log').innerHTML = taps.slice(-6).reverse()
    .map(t => `<li>${fmtMinutes(nzParts(t.ms).minutes)} ${TAP_NAMES[t.kind] ?? t.kind}${t.bearing != null ? `, mark ${t.bearing}°` : ''}</li>`).join('');
}

function tap(kind) {
  const taps = getTaps();
  const s = settings();
  const r = evaluate(bins, { nowMs: Date.now(), taps, veer: s.veer, layMinutes: s.lay, sequenceMinutes: s.seq, gradientRace: s.gradient });
  taps.push({ kind, ms: Date.now(), status: r.status, bearing: r.bearing.bearing, fw: r.latest?.fw ?? null, fd: r.latest?.fd ?? null });
  store.set(todayKey(), taps);
  render();
}

function downloadLog() {
  const rows = [['time', 'event', 'app_status', 'suggested_bearing', 'fairway_kn', 'fairway_dir']]
    .concat(getTaps().map(t => [new Date(t.ms).toISOString(), t.kind, t.status, t.bearing, t.fw?.toFixed?.(1) ?? '', t.fd?.toFixed?.(0) ?? '']));
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${todayKey()}.csv` });
  a.click();
}

async function refresh() {
  loadForecast().then(render);
  try {
    bins = bin10(cleanRows(await fetchRows()));
    $('updated').textContent = bins.length ? `updated ${fmtMinutes(nzParts(Date.now()).minutes)}` : 'no data yet today';
    $('updated').classList.remove('err');
  } catch (e) {
    $('updated').textContent = `${e.message}, showing last data`;
    $('updated').classList.add('err');
  }
  render();
}

for (const id of ['mode', 'area', 'sigOuter', 'sigInner', 'pctOuter', 'pctInner', 'veer', 'lay', 'seq']) {
  const saved = store.get(`setting-${id}`, null);
  if (saved != null) $(id).value = saved;
  $(id).addEventListener('change', () => { store.set(`setting-${id}`, $(id).value); watchGps(); render(); });
}
document.querySelectorAll('[data-tap]').forEach(b => b.addEventListener('click', () => tap(b.dataset.tap)));
$('download').addEventListener('click', downloadLog);
document.addEventListener('click', async e => {
  const b = e.target.closest('button.copy');
  if (!b?.dataset.copy) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
  b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1200);
});

let gpsWatch = null;
function watchGps() {
  if ($('area').value !== 'gps' || gpsWatch != null || !navigator.geolocation) return;
  gpsWatch = navigator.geolocation.watchPosition(
    p => { gps = { lat: p.coords.latitude, lon: p.coords.longitude }; render(); },
    () => { $('mark').innerHTML = '<div class="err">Location not available. Pick a course area instead.</div>'; },
    { enableHighAccuracy: true, maximumAge: 30000 },
  );
}

// Today's Open-Meteo forecast: inland top temperature, sea temperature and the gradient wind.
let forecast = null, forecastDate = null, forecastAt = 0;
async function loadForecast() {
  const p = nzParts(Date.now()), date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (forecastDate === date && Date.now() - forecastAt < 3600e3) return;
  try {
    const q = (pt, rest) => `latitude=${pt.lat}&longitude=${pt.lon}&timezone=Pacific%2FAuckland&forecast_days=1&${rest}`;
    const [w, m] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${q(FORECAST_INLAND, 'daily=temperature_2m_max&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn')}`).then(r => r.ok ? r.json() : null),
      fetch(`https://marine-api.open-meteo.com/v1/marine?${q(FORECAST_SEA, 'hourly=sea_surface_temperature')}`).then(r => r.ok ? r.json() : null),
    ]);
    if (w) { forecast = summariseForecast(w, m, date); forecastDate = date; forecastAt = Date.now(); }
  } catch { /* offline: no forecast line */ }
}

// The history is rebuilt nightly from all harbour data; the built-in table is the fallback.
async function loadHistory() {
  try {
    const res = await fetch('climatology.json', { cache: 'no-cache' });
    if (res.ok) setClimatology((await res.json()).months);
  } catch { /* offline: keep the built-in table */ }
}

watchGps();
loadHistory().then(refresh);
setInterval(refresh, REFRESH_MS);
