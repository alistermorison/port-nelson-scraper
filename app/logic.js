// Sea breeze logic for the race officer page. Pure functions only, so they can
// be tested with `node --test app/` and replayed against past days.

export const TZ = 'Pacific/Auckland';
export const SETTLED_BEARING = 355; // median settled sea breeze direction at the Fairway
export const ONSHORE_AXIS = 355;    // onshore component is measured along this bearing
export const MIN_STEADY_KN = 4;
export const ALERT_ONSHORE_KN = 2;
export const GRADIENT_KN = 12;      // breakfast wind at or above this usually means no clean sea breeze
export const POSTPONE_CHANCE = 0.3; // suggest postponing below this chance of a breeze before 13:00

// Fairway arrival of a 4 kn steady onshore breeze on light-morning days,
// 14 Jul to 16 Oct 2026. chance = share of those mornings with a breeze,
// before13 = share with a breeze by 13:00, minutes are NZ local time of day.
export const CLIMATOLOGY = {
  7:  { days: 11, chance: 0.73, before13: 0.09, p25: 812, p50: 850, p75: 850 },
  8:  { days: 23, chance: 0.70, before13: 0.26, p25: 687, p50: 805, p75: 847 },
  9:  { days: 20, chance: 0.80, before13: 0.75, p25: 647, p50: 675, p75: 715 },
  10: { days: 13, chance: 0.85, before13: 0.77, p25: 635, p50: 670, p75: 715 },
};

// From the replay: the first alert came a median 40 min before arrival,
// and the middle half of useful warnings fell 15 to 75 min ahead.
export const ALERT_LEAD = { early: 15, typical: 40, late: 75 };

// Replace the table above with one rebuilt from all data (climatology.json).
export function setClimatology(months) {
  if (!months || !Object.keys(months).length) return;
  for (const k of Object.keys(CLIMATOLOGY)) delete CLIMATOLOGY[k];
  for (const [k, v] of Object.entries(months)) CLIMATOLOGY[k] = v;
}

const MIN_DAY_BINS = 30; // a day needs at least 5 hours of readings between 09:00 and 16:00 to count
export const MIN_MONTH_DAYS = 8; // fewer usable mornings than this and the month borrows from its neighbour

const quantile = (sorted, q) => {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// Build the monthly table from days of 10-minute bins: [{month, bins}].
// Only light mornings count (breakfast wind under GRADIENT_KN), as in the original table.
export function buildClimatology(days) {
  const byMonth = {};
  for (const { month, bins } of days) {
    if (bins.filter(b => b.minutes >= 540 && b.minutes < 960 && b.fw != null).length < MIN_DAY_BINS) continue;
    const morning = morningMean(bins);
    if (morning == null || morning >= GRADIENT_KN) continue;
    const i = findSettled(bins);
    (byMonth[month] ??= []).push(i >= 0 ? bins[i].minutes : null);
  }
  const out = {};
  for (const [month, arrivals] of Object.entries(byMonth)) {
    if (arrivals.length < MIN_MONTH_DAYS) continue;
    const hit = arrivals.filter(m => m != null).sort((a, b) => a - b);
    if (!hit.length) continue;
    const r2 = x => Math.round(x * 100) / 100;
    out[month] = {
      days: arrivals.length,
      chance: r2(hit.length / arrivals.length),
      before13: r2(hit.filter(m => m <= 780).length / arrivals.length),
      p25: Math.round(quantile(hit, 0.25)), p50: Math.round(quantile(hit, 0.5)), p75: Math.round(quantile(hit, 0.75)),
    };
  }
  return out;
}

export function climatologyFor(month) {
  if (CLIMATOLOGY[month]) return { ...CLIMATOLOGY[month], month, fallback: false };
  // No history yet for this month: use the nearest month we have.
  const months = Object.keys(CLIMATOLOGY).map(Number);
  const dist = m => Math.min(Math.abs(m - month), 12 - Math.abs(m - month));
  const near = months.sort((a, b) => dist(a) - dist(b))[0];
  return { ...CLIMATOLOGY[near], month: near, fallback: true };
}

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
export const norm360 = d => ((d % 360) + 360) % 360;
export const angleDiff = (a, b) => ((a - b + 540) % 360) - 180;
export const isOnshore = dir => dir != null && (dir >= 270 || dir <= 60);

export function nzParts(ms) {
  const f = new Intl.DateTimeFormat('en-NZ', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, minutes: +p.hour * 60 + +p.minute };
}

export const fmtMinutes = m => {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

// Vector mean direction of (speed, direction) pairs, so 350 and 10 average to 0.
export function vectorMean(pairs) {
  let x = 0, y = 0, n = 0;
  for (const [s, d] of pairs) {
    if (s == null || d == null) continue;
    x += s * Math.sin(rad(d)); y += s * Math.cos(rad(d)); n++;
  }
  if (!n) return null;
  return norm360(deg(Math.atan2(x, y)));
}

// Drop repeated webcam frames and single-reading OCR spikes.
export function cleanRows(rows) {
  const seen = new Set();
  const r = rows.filter(x => {
    const k = x.image_update ?? x.created_at;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const despike = key => r.map((x, i) => {
    const a = r[i - 1]?.[key], b = r[i + 1]?.[key], v = x[key];
    if (v == null || a == null || b == null) return v;
    return Math.abs(v - a) > 12 && Math.abs(v - b) > 12 ? null : v;
  });
  const fw = despike('fairway_wind'), mw = despike('main_wharf_wind');
  return r.map((x, i) => ({ ...x, fairway_wind: fw[i], main_wharf_wind: mw[i] }));
}

// Average cleaned rows into 10-minute bins in NZ local time.
export function bin10(rows) {
  const bins = new Map();
  for (const x of rows) {
    const ms = Date.parse(x.created_at);
    const start = ms - (ms % 600000);
    if (!bins.has(start)) bins.set(start, []);
    bins.get(start).push(x);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => {
    const avg = k => {
      const v = xs.map(x => x[k]).filter(v => v != null);
      return v.length ? v.reduce((s, a) => s + a, 0) / v.length : null;
    };
    const comp = (sk, dk) => {
      const v = xs.filter(x => x[sk] != null && x[dk] != null)
        .map(x => x[sk] * Math.cos(rad(x[dk] - ONSHORE_AXIS)));
      return v.length ? v.reduce((s, a) => s + a, 0) / v.length : null;
    };
    const p = nzParts(t);
    return {
      t, minutes: p.minutes,
      fw: avg('fairway_wind'), mw: avg('main_wharf_wind'),
      fd: vectorMean(xs.map(x => [x.fairway_wind, x.fairway_dir])),
      md: vectorMean(xs.map(x => [x.main_wharf_wind, x.main_wharf_dir])),
      uf: comp('fairway_wind', 'fairway_dir'), um: comp('main_wharf_wind', 'main_wharf_dir'),
    };
  });
}

const consecutive = (a, b) => a && b && b.t - a.t === 600000;
const steadyBin = b => b && b.fw != null && b.fw >= MIN_STEADY_KN && isOnshore(b.fd);

// First time three consecutive bins (30 min) hold 4 kn or more onshore, from 09:00.
export function findSettled(bins) {
  for (let i = 0; i + 2 < bins.length; i++) {
    const [a, b, c] = [bins[i], bins[i + 1], bins[i + 2]];
    if (a.minutes < 540) continue;
    if (consecutive(a, b) && consecutive(b, c) && steadyBin(a) && steadyBin(b) && steadyBin(c)) return i;
  }
  return -1;
}

// First time either station blows 2 kn or more onshore for 20 min, from 08:30.
export function findAlert(bins) {
  for (let i = 1; i < bins.length; i++) {
    const [p, b] = [bins[i - 1], bins[i]];
    if (b.minutes < 510 || !consecutive(p, b)) continue;
    const wharf = b.um >= ALERT_ONSHORE_KN && p.um >= ALERT_ONSHORE_KN;
    const fairway = b.uf >= ALERT_ONSHORE_KN && p.uf >= ALERT_ONSHORE_KN;
    if (wharf || fairway) return i;
  }
  return -1;
}

export function morningMean(bins) {
  const v = bins.filter(b => b.minutes >= 420 && b.minutes < 540 && b.fw != null).map(b => b.fw);
  return v.length ? v.reduce((s, a) => s + a, 0) / v.length : null;
}

// Mean direction and spread (largest swing either side) over the last n bins.
export function recentDirection(bins, n = 3) {
  const last = bins.slice(-n).filter(b => b.fd != null && b.fw != null);
  if (!last.length) return null;
  const mean = vectorMean(last.map(b => [b.fw, b.fd]));
  const spread = Math.max(...last.map(b => Math.abs(angleDiff(b.fd, mean))));
  return { mean, spread };
}

// taps: [{kind, ms}], kinds: 'wind-on-water', 'plume', 'cloud', 'mark-laid', 'breeze-in'
export function evaluate(bins, { nowMs, taps = [], veer = 8, layMinutes = 15, sequenceMinutes = 5, gradientRace = false } = {}) {
  const now = nzParts(nowMs);
  const clim = climatologyFor(now.month);
  if (gradientRace) return evaluateGradient(bins, { now, clim, layMinutes, sequenceMinutes });
  const morning = morningMean(bins);
  const latest = bins.at(-1) ?? null;
  const settledIdx = findSettled(bins);
  const alertIdx = findAlert(bins);
  const tapAlert = taps.filter(t => t.kind === 'wind-on-water' && nowMs - t.ms <= 30 * 60000).at(-1);
  const steadyNow = bins.length >= 3 && steadyBin(bins.at(-1)) && steadyBin(bins.at(-2)) && steadyBin(bins.at(-3));
  const gradient = morning != null && morning >= GRADIENT_KN;

  let status, detail, window = null, start = null;

  if (settledIdx >= 0 && steadyNow) {
    status = 'Settled';
    detail = `Steady onshore breeze since ${fmtMinutes(bins[settledIdx].minutes)}.`;
    const s = Math.max(now.minutes, bins[settledIdx].minutes + 30) + layMinutes + sequenceMinutes;
    start = { start: s, warning: s - sequenceMinutes };
  } else if (settledIdx >= 0) {
    status = 'Unsettled';
    detail = `The breeze came in at ${fmtMinutes(bins[settledIdx].minutes)} but has eased or swung. Wait for 30 minutes of steady wind.`;
  } else if (alertIdx >= 0 || tapAlert) {
    status = 'Arriving';
    const from = alertIdx >= 0 ? bins[alertIdx].minutes + 10 : now.minutes;
    const lo = Math.max(now.minutes, from + ALERT_LEAD.early), hi = Math.max(now.minutes + 15, from + ALERT_LEAD.late);
    window = { lo, typical: Math.min(hi, Math.max(lo, from + ALERT_LEAD.typical)), hi };
    detail = alertIdx >= 0
      ? `Onshore wind building at ${Math.abs(bins[alertIdx].um ?? 0) >= ALERT_ONSHORE_KN ? 'Main Wharf' : 'the Fairway'} since ${fmtMinutes(bins[alertIdx - 1].minutes)}.`
      : 'You reported wind on the water to the north.';
  } else if (gradient) {
    status = 'Gradient wind';
    detail = `Breakfast wind at the Fairway averaged ${morning.toFixed(0)} kn. On days like this the sea breeze often does not form cleanly.`;
  } else if (latest && latest.minutes >= 480 && latest.fw != null && latest.fw < 5) {
    status = 'Building';
    detail = 'The overnight southerly has died away. This lull usually comes before the sea breeze.';
  } else {
    status = 'Waiting';
    detail = 'No sign of the sea breeze yet.';
  }

  if (!window && status !== 'Settled' && status !== 'Unsettled') {
    const lo = Math.max(now.minutes + 15, clim.p25), hi = Math.max(now.minutes + 30, clim.p75);
    window = { lo, typical: Math.min(hi, Math.max(lo, clim.p50)), hi, fromHistory: true };
  }
  if (!start && window) {
    const s = Math.max(window.typical, now.minutes + layMinutes) + sequenceMinutes;
    start = { start: s, warning: s - sequenceMinutes, provisional: true };
  }

  let bearing;
  if (status === 'Settled' || status === 'Unsettled') {
    const d = recentDirection(bins, 3);
    if (d) bearing = { bearing: norm360(Math.round(d.mean + veer)), spread: Math.max(5, Math.round(d.spread)), source: 'live' };
  }
  if (!bearing) {
    bearing = { bearing: SETTLED_BEARING, spread: 20, source: 'history' };
  }

  // Chance of a breeze by 13:00, from history, and whether to suggest postponing.
  let postpone = null;
  if (status !== 'Settled' && status !== 'Unsettled') {
    if (now.minutes >= 750 && status !== 'Arriving') {
      postpone = 'No sea breeze yet at 12:30. Consider postponing and checking again in 30 minutes.';
    } else if (gradient && status !== 'Arriving') {
      postpone = 'Strong breakfast wind. Consider postponing until the wind settles.';
    } else if (clim.before13 < POSTPONE_CHANCE && status === 'Waiting') {
      postpone = `In this month the breeze arrived by 13:00 on only ${Math.round(clim.before13 * 100)}% of mornings. Consider a later start.`;
    }
  }

  return { status, detail, window, start, bearing, postpone, morning, clim, latest, settledIdx, alertIdx };
}

// Racing in the gradient wind: any direction counts, and the axis is the live
// Fairway direction with no sea breeze veer added.
function evaluateGradient(bins, { now, clim, layMinutes, sequenceMinutes }) {
  const last = bins.slice(-3);
  const steady = last.length === 3 && consecutive(last[0], last[1]) && consecutive(last[1], last[2])
    && last.every(b => b.fw != null && b.fw >= MIN_STEADY_KN && b.fd != null);
  const d = recentDirection(bins, 3);
  const latest = bins.at(-1) ?? null;
  const base = { window: null, postpone: null, morning: morningMean(bins), clim, latest, settledIdx: -1, alertIdx: -1 };
  if (!steady || !d) {
    return {
      ...base, status: 'Too light', start: null,
      detail: 'Racing in the gradient wind, but the Fairway has not held 4 kn for the last 30 minutes.',
      bearing: d ? { bearing: norm360(Math.round(d.mean)), spread: Math.max(5, Math.round(d.spread)), source: 'gradient' }
        : { bearing: SETTLED_BEARING, spread: 20, source: 'history' },
    };
  }
  const kn = last.reduce((a, b) => a + b.fw, 0) / 3;
  const s = now.minutes + layMinutes + sequenceMinutes;
  return {
    ...base, status: 'Gradient race',
    detail: `Racing in the gradient wind: ${kn.toFixed(0)} kn from ${String(norm360(Math.round(d.mean))).padStart(3, '0')}°T at the Fairway.`,
    start: { start: s, warning: s - sequenceMinutes },
    bearing: { bearing: norm360(Math.round(d.mean)), spread: Math.max(5, Math.round(d.spread)), source: 'gradient' },
  };
}

// Point at a bearing and distance from a start point (nautical miles), on a sphere.
export function destination(lat, lon, bearingDeg, distNm) {
  const R = 3440.065; // earth radius in nautical miles
  const d = distNm / R, b = rad(bearingDeg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

// Degrees and decimal minutes, as used on charts: S41° 14.400'
export function fmtDDM(value, isLat) {
  const hemi = isLat ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  const a = Math.abs(value), dd = Math.floor(a), mm = (a - dd) * 60;
  return `${hemi}${dd}° ${mm.toFixed(3)}'`;
}

export const COURSE_AREAS = {
  east: { name: 'Eastern area', lat: -(41 + 14.4 / 60), lon: 173 + 16.186 / 60 },
  west: { name: 'Western area', lat: -(41 + 14.37 / 60), lon: 173 + 12.62 / 60 },
};

// Median ORC VPP figures (knots) from 2022–24 certificates, via github.com/jieter/orc-data.
// No Elliott 5.9 or Flying Fifteen certificates exist, so the SB20 stands in for the
// inner course until race results let us correct it with the speed setting.
export const POLARS = {
  j111: {
    name: 'J/111', tws: [6, 8, 10, 12, 14, 16, 20],
    beat: [3.84, 4.7, 5.21, 5.42, 5.52, 5.6, 5.67],
    run: [4.08, 5.16, 6.08, 6.68, 7.08, 7.56, 9.09],
    reach: [6.68, 7.53, 7.96, 8.24, 8.49, 8.78, 9.2],
  },
  e59: {
    name: 'Elliott 5.9 (SB20 figures)', tws: [6, 8, 10, 12, 14, 16, 20],
    beat: [3.08, 3.7, 4.07, 4.19, 4.22, 4.23, 4.23],
    run: [3.54, 4.41, 4.95, 5.4, 5.94, 6.66, 9.47],
    reach: [5.25, 5.86, 6.16, 6.55, 6.98, 7.38, 7.86],
  },
};

// Interpolate a polar row at a wind speed, holding the end values outside the table.
export function polarAt(p, key, tws) {
  const xs = p.tws, ys = p[key];
  if (tws <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (tws <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (tws - xs[i - 1]) / (xs[i] - xs[i - 1]);
  }
  return ys.at(-1);
}

// Legs per course signal in the 2027 Nelson Regatta SIs, Attachment A, in units of the
// beat length. Outer: Start–1–2–(3–2)–Finish, with the 1→2 reach taken as half a beat.
// Inner: Start–1a–(4–1a)–Finish.
export const COURSE_SIGNALS = {
  1: { course: 'outer', beats: 1, runs: 1, reaches: 0.5 },
  2: { course: 'outer', beats: 2, runs: 2, reaches: 0.5 },
  3: { course: 'outer', beats: 3, runs: 3, reaches: 0.5 },
  4: { course: 'inner', beats: 1, runs: 1, reaches: 0 },
  5: { course: 'inner', beats: 2, runs: 2, reaches: 0 },
  6: { course: 'inner', beats: 3, runs: 3, reaches: 0 },
};
export const TARGET_MINUTES = 45;

// Distance from the start to the windward mark (nm) so the leading boat takes the
// target time. speedFactor scales the polar (1 = as published).
export function beatLength(polar, tws, signal, { targetMinutes = TARGET_MINUTES, speedFactor = 1 } = {}) {
  const c = COURSE_SIGNALS[signal];
  const up = polarAt(polar, 'beat', tws) * speedFactor;
  const down = polarAt(polar, 'run', tws) * speedFactor;
  const reach = polarAt(polar, 'reach', tws) * speedFactor;
  const hoursPerNm = c.beats / up + c.runs / down + c.reaches / reach;
  return { nm: (targetMinutes / 60) / hoursPerNm, up, down };
}

// Wind speed to plan the course on: the Fairway mean over the last 30 minutes once
// there is breeze, otherwise the typical settled sea breeze.
export const TYPICAL_BREEZE_KN = 9;
export function raceWind(bins) {
  const v = bins.slice(-3).map(b => b.fw).filter(x => x != null);
  const mean = v.length ? v.reduce((s, a) => s + a, 0) / v.length : null;
  return mean != null && mean >= MIN_STEADY_KN ? { kn: mean, source: 'live' } : { kn: TYPICAL_BREEZE_KN, source: 'typical' };
}

// Buoy Zone's course axis is magnetic. Harbour station directions are true.
// WMM2025 gives 23.0° E at the Fairway for Oct 2026 to Jan 2027, changing by under 0.1° a year.
export const MAG_VARIATION_E = 23;
export const toMagnetic = trueDeg => norm360(Math.round(trueDeg - MAG_VARIATION_E));

// Forecast hint from Open-Meteo. Tested on 71 light mornings, Jul–Oct 2026: land
// barely warmer than the sea gave a breeze by 13:00 on 26% of mornings, 2.5° or more
// on 68%; a slight onshore gradient (09:00–13:00) on 72%, calm or offshore on about 37%.
export const FORECAST_INLAND = { lat: -41.38, lon: 173.12 }; // Waimea plains
export const FORECAST_SEA = { lat: -41.15, lon: 173.30 };    // Tasman Bay

// weather: Open-Meteo forecast JSON (daily temperature_2m_max, hourly wind_speed_10m and
// wind_direction_10m in knots, local times); marine: marine JSON (hourly sea_surface_temperature).
export function summariseForecast(weather, marine, date) {
  const di = weather?.daily?.time?.indexOf(date) ?? -1;
  const tmax = di >= 0 ? weather.daily.temperature_2m_max[di] : null;
  const H = weather?.hourly ?? { time: [] };
  const on = [];
  H.time.forEach((t, i) => {
    const h = +t.slice(11, 13);
    if (t.startsWith(date) && h >= 9 && h < 13 && H.wind_speed_10m[i] != null && H.wind_direction_10m[i] != null)
      on.push(H.wind_speed_10m[i] * Math.cos(rad(H.wind_direction_10m[i] - ONSHORE_AXIS)));
  });
  const M = marine?.hourly ?? { time: [] };
  const sea = M.time.map((t, i) => t.startsWith(date) ? M.sea_surface_temperature[i] : null).filter(v => v != null);
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const sst = mean(sea);
  return { tmax, sst, landSea: tmax != null && sst != null ? tmax - sst : null, gradOnshore: mean(on) };
}

export function forecastHint({ landSea, gradOnshore } = {}) {
  if (landSea == null && gradOnshore == null) return null;
  let score = 0; const parts = [];
  if (landSea != null) {
    const d = Math.round(landSea);
    if (landSea >= 2.5) { score++; parts.push(`land ${d}° warmer than the sea`); }
    else if (landSea < 1.2) { score--; parts.push(landSea < 0.5 ? 'land no warmer than the sea' : 'land barely warmer than the sea'); }
    else parts.push(`land ${d}° warmer than the sea`);
  }
  if (gradOnshore != null) {
    if (gradOnshore >= 0.5) { score++; parts.push('light onshore gradient'); }
    else if (gradOnshore <= -1.5) { score--; parts.push('offshore gradient'); }
    else parts.push('little gradient wind');
  }
  const verdict = score >= 1 ? 'likely before 13:00' : score <= -1 ? 'likely late, often after 13:00' : 'about usual for the month';
  const text = parts.join(', ');
  return { score, text: `Forecast: ${text}. Breeze ${verdict}.` };
}
