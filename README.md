# Family Finance

A home web app for tracking the family's finances. This round ships the app
shell, sign-in, and the **Assets** module. Spending, Planning and Tax are
placeholder pages for later rounds.

## Assets module

- **Properties** — address, photo (external URL or upload), BC Assessment
  assessed value, mortgage balance, and any number of **rate segments**
  (fixed / variable, each with its own start date and annual rate).
- **Mortgage projection chart** — month-by-month **monthly interest** and
  **remaining balance** lines (dual axis), with a selectable range
  (1 / 2 / 5 / 10 years, all the way to payoff, or a custom number of
  months), the total interest in range and the projected payoff month.
- **Other assets** — simple register grouped by category: Fixed assets,
  Stocks, Term deposits, Other, with subtotals.
- **Summary strip** — total property value (assessed), total mortgage
  balance, other assets, and net worth. Property values are BC Assessment
  *assessed* values, not market prices.

## Run with Docker

```bash
docker compose up -d --build
```

Then open <http://localhost:9200> (or `http://<host-ip>:9200` on the LAN).

- **Default sign-in: `admin` / `admin`** — change it before real use (see
  below).
- All data (SQLite database + uploaded photos) lives in the named Docker
  volume `finance-data`, so rebuilds and `git pull` never touch it. Only
  `docker compose down -v` deletes it.

### Changing the initial password

There is no change-password page yet this round. The seed credentials are
only used on the very first start, when the users table is empty: set
`SEED_ADMIN_USER` / `SEED_ADMIN_PASSWORD` in `docker-compose.yml` (or a
`.env` file) *before* the first `docker compose up`. To reset an existing
deployment back to a fresh seed, delete the volume
(`docker compose down -v`) — that erases all data.

## Run without Docker (development)

```bash
npm install
npm start            # http://localhost:9200
```

Environment variables: `PORT` (default 9200), `DATA_DIR` (default `./data`),
`SEED_ADMIN_USER`, `SEED_ADMIN_PASSWORD`.

## BC Assessment fetching

Adding a property tries one automatic fetch, and the detail page has a
**Fetch from BC Assessment** button to retry. The fetcher uses the public
site's own flow (address suggestions → property page → its ArcGIS map
service) and stores the total assessed value, the land/building split, the
assessment year and the matched address. It is best-effort — there is no
official API, so a site change can break it; failures are reported with the
stage that failed and never overwrite your saved values. Typing the value
manually always works, and manually edited values are marked "Manual".

Note: the public BC Assessment property page shows a map, not a house
photo, so photos cannot be fetched from it — add a photo by pasting an
external image URL or uploading an image file.

## Mortgage math

Canadian convention: quoted rates are nominal with semi-annual compounding,
so the monthly rate is `i = (1 + r/2)^(1/6) − 1`. Each projected month:
interest = balance × (that month's rate-segment rate), principal = payment
− interest. The monthly payment stored on the property wins; if empty, the
payment is derived from the remaining amortization years. Variable rates
are projected at the value entered — in reality they will change. If the
payment is below the monthly interest, the chart area shows a
negative-amortization warning and the balance grows accordingly.

## Tests

```bash
npm test     # engine unit tests (hand-computed fixtures)
npm run e2e  # HTTP end-to-end against a throwaway database
node tests/screenshot.mjs   # screenshots to tests/.work-shot (server on :9200)
```

## Layout

- `src/server.js` — Express app, auth, REST API
- `src/engine.js` — mortgage projection (pure functions)
- `src/bca.js` — BC Assessment fetcher
- `src/db.js` — SQLite schema and seed user
- `public/` — frontend (plain JS, Chart.js vendored under `public/vendor/`)
