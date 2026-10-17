# Sea Breeze Start

A phone page for the race officer near the Fairway Beacon. It reads the harbour
stations from Supabase every 2 minutes and shows:

- the breeze status (Waiting, Building, Arriving, Settled, Unsettled, Gradient wind)
- the expected arrival window and a suggested start time
- the windward mark bearing and its position from the chosen course area
- a postponement suggestion when the breeze looks unlikely before 13:00

Taps on "What you can see" are kept on the phone for the day and can be downloaded
as a CSV, so race days can be compared with what the app said.

`logic.js` holds all the rules as pure functions. Run the tests with
`node --test 'app/*.test.mjs'`. The page is published to GitHub Pages by
`.github/workflows/pages.yml` on every push to `main` that touches `app/`.
