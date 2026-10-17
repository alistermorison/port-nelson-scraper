# Sea Breeze Start · Whakatū Nelson

A phone page for the race officer near the Fairway Beacon. It reads the harbour
stations from Supabase every 2 minutes and shows:

- the breeze status (Waiting, Building, Arriving, Settled, Unsettled, Gradient wind)
- the expected arrival window and a suggested start time
- a "For Buoy Zone" panel: course axis, distances to marks 1 (outer, J/111) and 1a (inner,
  Elliott 5.9) sized for a 45-minute race, and start boat position, tap to copy
- a postponement suggestion when the breeze looks unlikely before 13:00
- a "Race in the gradient wind" setting: the axis follows the live Fairway wind from any
  direction (no veer added) and the start is as soon as the marks can be laid

Taps on "What you can see" are kept on the phone for the day and can be downloaded
as a CSV, so race days can be compared with what the app said.

`logic.js` holds all the rules as pure functions. Run the tests with
`node --test 'app/*.test.mjs'`. Netlify publishes the repo, so the page is at
`/app/` on the port-nelson-weather site.

The arrival history (expected arrival window, chance of a breeze by 13:00) is rebuilt
every night by `.github/workflows/climatology.yml`, which runs `build-climatology.mjs`
over all harbour data and commits `climatology.json`. The page loads that file and
falls back to the table in `logic.js` if it is missing. A month needs at least 8 light
mornings before it gets its own numbers; until then it borrows the nearest month's.

Before the breeze settles, the Breeze card also shows a forecast line from Open-Meteo
(no key needed): the forecast inland top temperature against the Tasman Bay sea
temperature, and the gradient wind from 09:00 to 13:00. On 71 light mornings from July
to October 2026, land 2.5° or more warmer than the sea gave a breeze by 13:00 on 68% of
mornings (26% when barely warmer), and a slight onshore gradient on 72% (about 37% when
calm or offshore). Re-check these thresholds once summer data is in.
