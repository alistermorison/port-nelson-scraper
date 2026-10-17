# Sea Breeze Start

A phone page for the race officer near the Fairway Beacon. It reads the harbour
stations from Supabase every 2 minutes and shows:

- the breeze status (Waiting, Building, Arriving, Settled, Unsettled, Gradient wind)
- the expected arrival window and a suggested start time
- a "For BuoyZone" panel: course axis, distances to marks 1 (outer, J/111) and 1a (inner,
  Elliott 5.9) sized for a 45-minute race, and start boat position, tap to copy
- a postponement suggestion when the breeze looks unlikely before 13:00

Taps on "What you can see" are kept on the phone for the day and can be downloaded
as a CSV, so race days can be compared with what the app said.

`logic.js` holds all the rules as pure functions. Run the tests with
`node --test 'app/*.test.mjs'`. Netlify publishes the repo, so the page is at
`/app/` on the port-nelson-weather site.
