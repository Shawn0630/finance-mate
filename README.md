# Finance Mate

A home web app for tracking the family's finances. This round ships the app
shell, sign-in, and the **Assets** module. Spending, Planning and Tax are
placeholder pages for later rounds.

## Assets module

- **Properties** — address, a photo gallery (upload any number of local
  photos; they show as a carousel on the detail page and the first one
  is the card cover), BC Assessment
  assessed value, outstanding principal, and any number of **rate segments**
  (fixed / variable, each with its own start date and annual rate).
- **Mortgage projection chart** — one merged chart on the property page:
  the assessed-value and **outstanding principal** lines plus stacked
  bars splitting each payment into its **interest** and **principal**
  portions (yearly bars on spans over 10 years), on a single amount
  axis that starts at 0. The chart panel carries its own range controls
  (1 / 2 / 5 / 10 years, all the way to payoff, or a custom number of
  months), with the projected total interest and payoff month beside it.
- **Other assets** — simple register by category: Fixed assets, Stocks,
  Term deposits, Other, with subtotals.
- **Layout** — the Assets module has a persistent secondary menu:
  **Overview** shows totals only (property value, outstanding principal, other
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

Every property and every other asset has **owners**: a set of people,
picked with a multi-select tag control. Joint ownership is simply
picking several people (e.g. Shawn + Jiaying) — there is no special
`Joint` value. The candidates are the sign-in users **except admin**
(the admin account manages the app and is never an owner). The server
rejects `admin`, the literal `Joint`, and any name that is not a user.
Owners are stored as a JSON array and show as chips on property cards,
in the asset tables and on the detail pages; summaries are not broken
down by owner. (Databases from before the multi-owner change are
migrated automatically: a single stored owner becomes a one-element
set, and a stored `Joint` becomes an empty set, since it named no
concrete people.)

## Admin & avatars

Signing in as **admin** reveals an **Admin** page (the API enforces
admin-only access with 403 for everyone else) for managing users:
add a user (username + initial password), reset a password (which
signs that user out everywhere), delete a user (the admin user itself
cannot be deleted; a deleted user's name is scrubbed from every
owners list), and set profile pictures.

Every user has an **avatar**: an uploaded photo if one was set on the
Admin page (JPEG/PNG/WebP/GIF, up to 5 MB, stored as a file under the
data directory — the user row keeps only the file name), otherwise a
**letter avatar** — the username's initial on a per-user background
color that is stored on the user row (Shawn is blue `#2563eb`,
Jiaying is pink `#db2777`, admin is slate `#607d8b`; later users get a
color from the same palette by username hash). "Restore default" on
the Admin page removes the photo and brings the letter avatar back.

Avatars appear next to the signed-in user's name in the top bar, in
the Admin user list, and inside every owner chip — property cards,
the property detail page, asset tables and asset details. Owner chips
read avatar data from the users table at render time, so changing a
picture in Admin updates all of those places on the next load.

## Assessed value trend

The property detail page charts the assessed value per year. The app
keeps it up to date by itself:

- **Current year — BC Assessment, fetch-on-read.** When a property
  detail or the portfolio is loaded, a property that carries a BC
  Assessment id is re-fetched (through the by-id property-page + GIS
  channel, not the address search) when it has never been fetched,
  when its stored year is behind the current roll, or when the last
  fetch is over 7 days old. Attempts are gated to one per property
  per day; a failure keeps the stored value and the page flags it as
  stale with the failing stage named.
- **Earlier years — HouseSigma.** BC Assessment has no prior-year
  values to backfill from (investigated live, Oct 2026: the GIS layer
  behind the property page carries only the current extract's values,
  and the page shows no history). The prior years are pulled from
  HouseSigma's assessment tables, which are drawn from the same
  public records — once in the background when a property is added,
  and again whenever you press **Pull history from HouseSigma** on
  the detail page. The HouseSigma ids are stored on the property so
  later pulls skip the address lookup.

Points keep the strongest source: a point you entered by hand is
never overwritten, a BC Assessment point beats a HouseSigma point
for the same year, and HouseSigma only fills missing years and
refreshes its own points. Points can still be added, edited and
deleted by hand below the chart.

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
photo, so photos cannot be fetched from it — click the photo area on a
property's detail page to upload photos from your computer. (Properties
recorded earlier may still carry an external photo URL; it shows in the
gallery as one entry and can be removed there, which clears it for good.)

## Mortgage math

A mortgage is modelled as a chain of **terms** — the way Canadian
lenders actually run it. Each term is one contract: a lender, a
start date, a length (1–120 months; the UI offers 1/2/3/4/5/7/10-year
quick picks), the amortization agreed for that term, and the balance
it opened with. Inside a term, two kinds of events can happen: a
**rate change** (a new rate segment — fixed or variable, switchable
at any time) and a **lump sum** (a one-off principal payment on a
date). When a term ends, a renewal starts the next term — possibly
with another bank and a fresh amortization; adding one prefills its
start (the day after the previous term ends) and its opening balance
(the previous term's projected end balance), and leaves the
amortization for you to re-enter.

Canadian convention: quoted rates are nominal with semi-annual compounding,
so the monthly rate is `i = (1 + r/2)^(1/6) − 1`. Each projected month:
interest = balance × (that month's rate-segment rate), principal = payment
− interest. The **payment is calculated automatically**: at the
balance anchor and again at every event (term start, segment start,
lump sum) it is recomputed from the balance at that point, the rate
then in effect, and the active term's *remaining* amortization (its
amortization minus the months already elapsed in the term). A lump
sum comes off the principal first, then the payment is recomputed on
what remains — so the payment drops and the total interest falls. A
monthly payment entered by hand is an **override**: it rules inside
the current term only, and the automatic calculation resumes at the
next term. (A later term with no amortization yet keeps the previous
payment until one is set.) If the payment is below the monthly
interest, the chart area shows a negative-amortization warning and
the balance grows accordingly. With no rate plan there is no
projection at all; with a plan but no amortization on the current
term and no entered payment, the state is NO_PAYMENT.

The detail page is laid out as: Gallery (the photo wall),
Property Details (minimal read-only metadata, Edit in the panel
head), then Value & Mortgage Projection — the hero section, whose
chart plots assessed value and outstanding principal on the left
axis and the payment split on a right payment axis, over a monthly
schedule table (paged by year) whose Total row carries the
projection's total payment, principal and interest and the payoff
month. Terms, their segments and their lump sums all live in the
Mortgage Terms & Rates modal (opened from the projection section),
as an accordion under a modal-top summary (current term, lender,
rate in effect, and the payment in use — labelled auto or entered).
The Mortgage form at the top of the modal edits the current balance
anchor plus the current term's amortization and lender (25 / 30
quick picks for the usual Canadian maximums — insured mortgages are
generally capped at 25 years, 30 for first-time buyers and newly
built homes since Dec 15, 2024, and uninsured mortgages at 30; the
field accepts 1–35 for planning, flagging anything past 30). When
the payment is derived, the modal names the derived amount. The
merged chart shows each payment split into its interest portion and
principal portion (stacked bars; the two sum to the payment). The
current term's lender (free text, with the big Canadian banks as
suggestions) also shows in the modal heading and in the Property
Details metadata once set. The assessment source data — BC
Assessment fetch, HouseSigma history pull, the history points and
their editor — lives in the Assessment History modal, also opened
from the projection section.

Existing databases migrate in place on boot: each property gets a
Term 1 that mirrors the pre-term model (start at the earliest
segment, 60 months, the property's amortization — or a flagged
25-year default when none was recorded — the current balance as its
opening balance, the property's lender), and its segments are
assigned to it, so a migrated mortgage projects month-by-month
exactly as before.

Variable segments can be priced two ways: as an absolute rate, or
relative to prime ("Prime + spread", e.g. Prime − 1). The app tracks
the Bank of Canada prime lending rate itself (Valet series
V80691311; history is kept in the `prime_rates` table). Freshness is
fetch-on-read: a projection or property request first makes sure
prime was successfully fetched today (America/Vancouver) — if not,
it pulls once inline (single-flight, short timeout) and computes
with the new value. If the Bank of Canada is unreachable, the last
known value is used instead, the API response flags it
(`prime: { rate, asOf, fresh: false }`), and the page shows an amber
warning naming the rate and date in use. A manual Refresh button
sits in the Mortgage Terms & Rates modal. When the current term's
plan in effect prices off prime, the modal also draws the tracked
prime history as a stepped chart (from just before the plan began
through today) in place of the banner's recent-changes text. A prime-priced segment always
resolves against the latest stored prime, floored at 0%, and
projections hold prime constant — the detail page states the value
and its as-of date.

## Regions

Region-specific logic sits behind one thin interface in
`src/regions/` (`getRegion(code)` returns the region's
implementation). Only Canada (`CA`) is implemented and accepted for
now — properties carry a `region` column defaulting to `CA`, and the
API refuses other values. A region implementation provides:

- `periodRate(annualRate, periodsPerYear)` — the interest convention
  (Canada: nominal rate, semi-annual compounding,
  `(1 + r/2)^(2/N) − 1`; the engine never hardcodes it)
- the prime-rate source and fetch (Canada: Bank of Canada Valet)
- the assessment provider (Canada: BC Assessment, via `src/bca.js`)
- the assessment-history provider (Canada: HouseSigma, via
  `src/housesigma.js`)

To support a new region later (e.g. a US state), add one module
implementing those pieces and register it in
`src/regions/index.js` — no engine or API changes.

## Tests

```bash
npm test     # engine unit tests (hand-computed fixtures)
npm run e2e  # HTTP end-to-end against a throwaway database
node tests/screenshot.mjs   # screenshots to tests/.work-shot (server on :9200)
```

## Layout

- `src/server.js` — Express app, auth, REST API
- `src/engine.js` — mortgage projection (pure functions)
- `src/regions/` — region interface + the Canada implementation
  (interest convention, prime source, assessment provider)
- `src/prime.js` — prime-rate storage and refresh policy
- `src/assessed.js` — assessed-value upkeep: BC Assessment
  fetch-on-read, HouseSigma history pulls, import priority rules
- `src/bca.js` — BC Assessment fetcher
- `src/housesigma.js` — HouseSigma history fetcher (guest session +
  the site's encrypted detail API, reverse-engineered Oct 2026)
- `src/db.js` — SQLite schema and seed user
- `public/` — frontend (plain JS, Chart.js vendored under `public/vendor/`)
