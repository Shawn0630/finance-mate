# Finance Mate

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
- **Other assets** — simple register by category: Fixed assets, Stocks,
  Term deposits, Other, with subtotals.
- **Layout** — the Assets module has a persistent secondary menu:
  **Overview** shows totals only (property value, mortgage balance, other
  assets, net worth, plus per-category breakdown cards); each section
  (Properties / Fixed assets / Stocks / Term deposits / Other) shows only
  its own listing, an Add button that opens a modal form, and a detail
  view per item (click a property card or an asset row). The section is
  kept in the URL hash (`#assets/stocks`, `#property/<id>`, `#asset/<id>`).
  Property values are BC Assessment *assessed* values, not market prices.

## Run with Docker

```bash
docker compose up -d --build
```

Then open <http://localhost:9200> (or `http://<host-ip>:9200` on the LAN).

- **Default sign-ins: `admin` / `admin`, `Shawn` / `Shawn`,
  `Jiaying` / `Jiaying`** — change them before real use (see below).
- All data (SQLite database + uploaded photos) lives in the named Docker
  volume `finance-mate-data`, so rebuilds and `git pull` never touch it. Only
  `docker compose down -v` deletes it.

### Changing the initial passwords

There is no change-password page yet. The three seed accounts are created
only when that username does not exist yet, so seeds never overwrite a
password you changed (there is currently no in-app way to change one —
resetting means editing the database or starting over). The admin seed
can be overridden with `SEED_ADMIN_USER` / `SEED_ADMIN_PASSWORD` in
`docker-compose.yml` (or a `.env` file) *before* the first
`docker compose up`. To reset an existing deployment back to a fresh seed,
delete the volume (`docker compose down -v`) — that erases all data.

## Run without Docker (development)

```bash
npm install
npm start            # http://localhost:9200
```

Environment variables: `PORT` (default 9200), `DATA_DIR` (default `./data`),
`SEED_ADMIN_USER`, `SEED_ADMIN_PASSWORD`.

## Owners

Every property and every other asset can have an **owner**: one of the
sign-in users, or — **for properties only** — `Joint`. The owner dropdowns
are filled from the users table (admin included, since it is a real
login). The server rejects `Joint` for non-property assets, and rejects
names that are not users. Owners show as a chip on property cards and in
the asset tables; summaries are not broken down by owner.

## Assessed value trend

The property detail page charts the assessed value per year. Every
successful BC Assessment fetch records that year's value automatically;
earlier years can be added, edited and deleted by hand below the chart.

**BC Assessment has no prior-year values to backfill from.** Investigated
live (Oct 2026): the full attribute set of the GIS layer behind the
property page contains only the current extract's `TOTAL_ASSESSED` /
`TOTAL_LAND` / `TOTAL_BUILDING` (plus sale fields, which were empty), and
the property page itself shows no previous-year values. So the trend
starts with the year you first fetch and grows one point per year (or
per manual entry) from there.

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
