import test from 'node:test';
import assert from 'node:assert/strict';
import {
  climatologyFor, vectorMean, cleanRows, bin10, findSettled, findAlert, evaluate,
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
  assert.equal(settled.bearing.bearing, 3); // 355 + 8 veer
  assert.equal(settled.start.start, 700 + 15 + 5);
  assert.equal(settled.start.warning, 715);
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
