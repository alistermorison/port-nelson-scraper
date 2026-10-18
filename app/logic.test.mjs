import test from 'node:test';
import assert from 'node:assert/strict';
import {
  noBreezeWarning, summariseForecast, forecastHint, climatologyFor, setClimatology, buildClimatology, CLIMATOLOGY, vectorMean, cleanRows, bin10, findSettled, findAlert, evaluate, findDirectionSteady,
  destination, fmtDDM, fmtMinutes, nzParts, COURSE_AREAS,
  POLARS, polarAt, COURSE_SIGNALS, beatLength, raceWind, TYPICAL_BREEZE_KN, toMagnetic,
} from './logic.js';

// 10 Oct 2026 is NZ daylight time (UTC+13), so NZ 00:00 is 11:00 UTC the day before.
const NZ_MIDNIGHT = Date.parse('2026-10-09T11:00:00Z');
const at = minutes => NZ_MIDNIGHT + minutes * 60000;

// One row every 5 minutes from `from` to `to` (NZ minutes), wind given by fn(minutes).
function rows(from, to, fn) {
  const out = [];
  for (let m = from; m < to; m += 5) {
    const w = fn(m);
    out.push({
      created_at: new Date(at(m)).toISOString(), image_update: `frame-${m}`,
      fairway_wind: w.fw, fairway_dir: w.fd, main_wharf_wind: w.mw ?? w.fw * 0.7, main_wharf_dir: w.md ?? w.fd,
    });
  }
  return out;
}
const day = fn => bin10(cleanRows(rows(360, 780, fn)));

// Typical sea breeze day: southerly dies at 09:00, onshore 3 kn from 10:30, 6 kn from 11:00.
const seaBreeze = m => m < 540 ? { fw: 6, fd: 180 } : m < 630 ? { fw: 2, fd: 120 } : m < 660 ? { fw: 3, fd: 350 } : { fw: 6, fd: 355 };

test('nzParts and fmtMinutes use NZ local time', () => {
  assert.deepEqual(nzParts(at(615)), { year: 2026, month: 10, day: 10, minutes: 615 });
  assert.equal(fmtMinutes(615), '10:15');
  assert.equal(fmtMinutes(-5), '23:55');
});

test('vectorMean averages across north', () => {
  assert.ok(Math.abs(vectorMean([[5, 350], [5, 10]])) < 1e-9 || Math.abs(vectorMean([[5, 350], [5, 10]]) - 360) < 1e-9);
  assert.equal(Math.round(vectorMean([[5, 80], [5, 100]])), 90);
  assert.equal(vectorMean([[null, 10]]), null);
});

test('cleanRows drops repeated frames and single spikes', () => {
  const r = rows(600, 630, () => ({ fw: 5, fd: 0 }));
  r.push({ ...r[0] });            // duplicate frame
  r[3].fairway_wind = 40;         // OCR spike
  const c = cleanRows(r);
  assert.equal(c.length, 6);
  assert.equal(c[3].fairway_wind, null);
  assert.equal(c[2].fairway_wind, 5);
});

test('climatology falls back to the nearest month', () => {
  assert.equal(climatologyFor(9).fallback, false);
  const dec = climatologyFor(12);
  assert.equal(dec.fallback, true);
  assert.equal(dec.month, 10);
  assert.equal(climatologyFor(5).month, 7);
});

test('destination and fmtDDM put the mark the right distance away', () => {
  const { lat, lon } = COURSE_AREAS.east;
  assert.equal(fmtDDM(lat, true), "S41° 14.400'");
  assert.equal(fmtDDM(lon, false), "E173° 16.186'");
  const [lat2, lon2] = destination(lat, lon, 0, 1);
  assert.ok(Math.abs((lat2 - lat) * 60 - 1) < 0.001, 'one nm north is one minute of latitude');
  assert.ok(Math.abs(lon2 - lon) < 1e-9);
  const [, lon3] = destination(lat, lon, 90, 1);
  assert.ok(lon3 > lon);
});

test('findAlert and findSettled on a sea breeze day', () => {
  const b = day(seaBreeze);
  assert.equal(b[findAlert(b)].minutes, 640);   // second bin of 3 kn onshore at 10:30
  assert.equal(b[findSettled(b)].minutes, 660); // first of three 6 kn bins from 11:00
});

test('evaluate walks through the morning statuses', () => {
  const all = day(seaBreeze);
  const upTo = m => all.filter(x => x.minutes < m);
  const ev = m => evaluate(upTo(m), { nowMs: at(m) });

  const early = ev(480);
  assert.equal(early.status, 'Waiting');
  assert.ok(early.window.fromHistory);
  assert.equal(early.bearing.source, 'history');
  assert.equal(early.start.provisional, true);

  assert.equal(ev(600).status, 'Building');

  const arriving = ev(650);
  assert.equal(arriving.status, 'Arriving');
  assert.ok(!arriving.window.fromHistory);
  assert.equal(arriving.postpone, null);

  const settled = ev(700);
  assert.equal(settled.status, 'Settled');
  assert.equal(settled.bearing.source, 'live');
  assert.equal(settled.bearing.bearing, 355); // already on the usual axis, no swing
  // Settled at 11:00 but not yet 50 minutes of direction history: hold the start.
  assert.equal(settled.swinging, true);
  assert.equal(settled.start.provisional, true);
  assert.equal(settled.start.start, 660 + 70 + 15 + 5);
  const noHold = evaluate(upTo(700), { nowMs: at(700), holdForDirection: false });
  assert.equal(noHold.start.start, 700 + 15 + 5);
  assert.equal(noHold.start.warning, 715);
  const steady = ev(760);                          // 355 all along: steady from the 11:50 bin
  assert.equal(steady.swinging, false);
  assert.equal(steady.start.provisional, undefined);
  assert.equal(steady.start.start, 760 + 15 + 5);
});

test('evaluate flags breeze that comes in then fades', () => {
  const b = day(m => m >= 720 ? { fw: 2, fd: 200 } : seaBreeze(m));
  const r = evaluate(b.filter(x => x.minutes < 760), { nowMs: at(760) });
  assert.equal(r.status, 'Unsettled');
  assert.equal(r.start, null);
});

test('evaluate suggests postponing on a gradient day and at 12:30 with nothing', () => {
  const gale = day(() => ({ fw: 18, fd: 220 }));
  const g = evaluate(gale.filter(x => x.minutes < 600), { nowMs: at(600) });
  assert.equal(g.status, 'Gradient wind');
  assert.ok(g.postpone);

  const calm = day(() => ({ fw: 1, fd: 150 }));
  const c = evaluate(calm.filter(x => x.minutes < 760), { nowMs: at(760) });
  assert.equal(c.status, 'Building');
  assert.match(c.postpone, /12:30/);
});

test('a wind-on-water tap raises the alert', () => {
  const calm = day(() => ({ fw: 1, fd: 150 }));
  const now = at(600);
  const r = evaluate(calm.filter(x => x.minutes < 600), { nowMs: now, taps: [{ kind: 'wind-on-water', ms: now - 5 * 60000 }] });
  assert.equal(r.status, 'Arriving');
  assert.match(r.detail, /You reported/);
});

test('polarAt interpolates and holds the ends', () => {
  const p = POLARS.j111;
  assert.equal(polarAt(p, 'beat', 4), 3.84);
  assert.equal(polarAt(p, 'beat', 25), 5.67);
  assert.ok(Math.abs(polarAt(p, 'beat', 9) - (4.7 + 5.21) / 2) < 1e-9);
});

test('beatLength hits the 45-minute target', () => {
  for (const [boat, signal] of [['e59', 5], ['j111', 2], ['e59', 4], ['j111', 3]]) {
    const p = POLARS[boat], c = COURSE_SIGNALS[signal];
    const { nm } = beatLength(p, 10, signal);
    const minutes = 60 * nm * (c.beats / polarAt(p, 'beat', 10) + c.runs / polarAt(p, 'run', 10) + c.reaches / polarAt(p, 'reach', 10));
    assert.ok(Math.abs(minutes - 45) < 1e-9, `${boat} signal ${signal}`);
  }
  // Two laps of the inner course in 10 kn: about 0.8 nm for an SB20-speed boat.
  assert.ok(Math.abs(beatLength(POLARS.e59, 10, 5).nm - 0.84) < 0.02);
  // Slower boats get a shorter course.
  assert.ok(beatLength(POLARS.e59, 10, 5, { speedFactor: 0.9 }).nm < beatLength(POLARS.e59, 10, 5).nm);
});

test('raceWind uses live Fairway wind once there is breeze', () => {
  assert.deepEqual(raceWind([{ fw: 2 }, { fw: 3 }, { fw: 2 }]), { kn: TYPICAL_BREEZE_KN, source: 'typical' });
  assert.deepEqual(raceWind([{ fw: 6 }, { fw: 8 }, { fw: 10 }]), { kn: 8, source: 'live' });
});

test('toMagnetic takes off the 23° east variation', () => {
  assert.equal(toMagnetic(3), 340);
  assert.equal(toMagnetic(355), 332);
  assert.equal(toMagnetic(30), 7);
});

test('buildClimatology rebuilds the monthly table from whole days', () => {
  const full = fn => bin10(cleanRows(rows(360, 960, fn)));
  const breeze = full(seaBreeze);                       // settles 11:00
  const late = full(m => seaBreeze(m - 150));           // settles 13:30
  const none = full(() => ({ fw: 3, fd: 180 }));        // no breeze
  const windy = full(m => m < 540 ? { fw: 15, fd: 200 } : seaBreeze(m)); // gradient morning, skipped
  const short = bin10(cleanRows(rows(360, 780, seaBreeze)));             // too few readings, skipped
  const days = [
    ...Array(6).fill({ month: 11, bins: breeze }), ...Array(2).fill({ month: 11, bins: late }),
    ...Array(2).fill({ month: 11, bins: none }), { month: 11, bins: windy }, { month: 11, bins: short },
    ...Array(3).fill({ month: 12, bins: breeze }), // too few days for December
  ];
  const c = buildClimatology(days);
  assert.deepEqual(Object.keys(c), ['11']);
  assert.equal(c[11].days, 10);
  assert.equal(c[11].chance, 0.8);
  assert.equal(c[11].before13, 0.6);
  assert.equal(c[11].p50, 660);
  assert.equal(c[11].p75, 698); // between 11:00 and 13:30, a quarter of the way

  const before = structuredClone(CLIMATOLOGY);
  setClimatology(c);
  assert.equal(climatologyFor(11).fallback, false);
  assert.equal(climatologyFor(1).month, 11);
  setClimatology({});              // empty input keeps the current table
  assert.equal(climatologyFor(11).p50, 660);
  setClimatology(before);
});

test('gradient race mode uses the live wind from any direction', () => {
  const southerly = day(() => ({ fw: 9, fd: 200 }));
  const sea = evaluate(southerly, { nowMs: at(770) });
  assert.notEqual(sea.status, 'Settled');
  assert.equal(sea.bearing.source, 'history');

  const r = evaluate(southerly, { nowMs: at(770), gradientRace: true, layMinutes: 15, sequenceMinutes: 5 });
  assert.equal(r.status, 'Gradient race');
  assert.equal(r.bearing.bearing, 200);            // no veer added
  assert.equal(r.bearing.source, 'gradient');
  assert.equal(r.start.start, 790);
  assert.equal(r.postpone, null);

  const light = evaluate(day(() => ({ fw: 2, fd: 200 })), { nowMs: at(770), gradientRace: true });
  assert.equal(light.status, 'Too light');
  assert.equal(light.start, null);
});

test('forecast summary and hint', () => {
  const weather = {
    daily: { time: ['2026-10-18'], temperature_2m_max: [19] },
    hourly: {
      time: ['2026-10-18T08:00', '2026-10-18T09:00', '2026-10-18T10:00', '2026-10-18T11:00', '2026-10-18T12:00', '2026-10-18T13:00'],
      wind_speed_10m: [9, 2, 2, 2, 2, 9], wind_direction_10m: [180, 355, 355, 355, 355, 180],
    },
  };
  const marine = { hourly: { time: ['2026-10-18T00:00', '2026-10-18T12:00', '2026-10-19T00:00'], sea_surface_temperature: [15, 16, 20] } };
  const f = summariseForecast(weather, marine, '2026-10-18');
  assert.equal(f.sst, 15.5);
  assert.equal(f.landSea, 3.5);
  assert.ok(Math.abs(f.gradOnshore - 2) < 1e-9); // only 09:00–12:00 counts
  assert.match(forecastHint(f).text, /likely before 13:00/);
  assert.match(forecastHint({ landSea: 0.2, gradOnshore: -3 }).text, /no warmer.*offshore.*after 13:00/);
  assert.match(forecastHint({ landSea: 3, gradOnshore: -3 }).text, /about usual/);
  assert.equal(forecastHint({}), null);
});

test("last evening's sea breeze does not count this morning", () => {
  // Yesterday 18:00–24:00 onshore at both stations, then a 7 kn southerly from midnight.
  const bins = bin10(cleanRows(rows(-360, 420, m => m < 0 ? { fw: 6, fd: 350 } : { fw: 7, fd: 168 })));
  const r = evaluate(bins, { nowMs: at(417) });
  assert.equal(r.status, 'Waiting');
  assert.equal(r.alertIdx, -1);
  assert.equal(r.settledAt, null);
  assert.ok(r.window.lo >= 417 && r.window.lo < 1440); // a morning window, not 23:35
});

test('raceWind ignores an offshore wind before the sea breeze', () => {
  const southerly = day(() => ({ fw: 7, fd: 170 }));
  assert.equal(raceWind(southerly).source, 'live');
  assert.deepEqual(raceWind(southerly, { onshoreOnly: true }), { kn: TYPICAL_BREEZE_KN, source: 'typical' });
  assert.equal(raceWind(day(() => ({ fw: 11, fd: 355 })), { onshoreOnly: true }).source, 'live');
});

test('warns that the breeze may not come on a strong offshore gradient day', () => {
  assert.match(noBreezeWarning({ gradOnshore: -4.2 }, 9.6), /may not come.*4 kn offshore.*10 kn at breakfast.*never came on 9/);
  assert.equal(noBreezeWarning({ gradOnshore: -4.2 }, 5), null);   // light breakfast wind
  assert.equal(noBreezeWarning({ gradOnshore: -1 }, 12), null);    // little gradient forecast
  assert.equal(noBreezeWarning(null, 12), null);
});

test('a new westerly breeze is set towards 355, fading over two hours', () => {
  // Settles at 11:00 from 295 (60 degrees short of 355); data runs to 12:59.
  const all = day(m => m < 660 ? { fw: 2, fd: 160 } : { fw: 7, fd: 295 });
  const ev = m => evaluate(all.filter(x => x.minutes < m), { nowMs: at(m) });
  const first = ev(700).bearing;                      // 40 minutes after settling
  assert.equal(first.live, 295);
  assert.equal(first.swing, 34);                      // 0.85 * (1 - 40/120) * 60
  assert.equal(first.bearing, 329);
  assert.ok(ev(770).bearing.swing < first.swing);     // shrinks as the breeze ages
  assert.equal(evaluate(all, { nowMs: at(660 + 130) }).bearing.swing, 0);
});

test('the first start waits while the breeze is still swinging', () => {
  // Arrives from 290 at 11:00 and veers 0.5 degrees a minute until 355 at 13:10.
  const all = day(m => m < 660 ? { fw: 2, fd: 160 } : { fw: 7, fd: Math.min(355, 290 + (m - 660) / 2) });
  const ev = m => evaluate(all.filter(x => x.minutes < m), { nowMs: at(m) });
  assert.equal(ev(740).swinging, true);
  assert.equal(ev(740).status, 'Settled');
  assert.equal(findDirectionSteady(all, findSettled(all)), -1); // still veering at 12:50
});
