// Holiday calendar for the next-pay-date rule: a payday landing on a
// Canadian or US holiday moves one day earlier (user rule 2026-11-01).
//
// Union of Canadian federal statutory holidays, BC statutory
// holidays (the user works in BC), and US federal holidays. Dates are
// computed per year (fixed dates + nth-weekday rules + Easter), so
// any year works — no hardcoded table to go stale.
//
// Deliberately literal: only the holiday DATE itself counts. A
// holiday falling on a weekend does NOT shift to a Friday/Monday
// observance (payroll observance varies by employer); the rule as
// stated moves a payday only when it lands on the holiday date.
// Consecutive holidays keep stepping back: a Dec 26 payday moves to
// Dec 24, never to Dec 25, which is itself a holiday.

const DAY = 86400000;
const RE = /^\d{4}-\d{2}-\d{2}$/;

function dayNum(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
}
function dayStr(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}
function pad(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// nth weekday of a month (weekday 0 = Sunday, n = 1-based).
function nthWeekday(y, m, weekday, n) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const d = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return pad(y, m, d);
}
function lastWeekday(y, m, weekday) {
  const last = new Date(Date.UTC(y, m, 0));
  const d = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return pad(y, m, d);
}
// Easter Sunday (Anonymous Gregorian computus); Good Friday is -2d.
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return pad(y, month, day);
}
// Victoria Day: the Monday preceding May 25 (the Monday on or
// before May 24).
function victoriaDay(y) {
  let n = Date.UTC(y, 4, 24) / DAY;
  while (new Date(n * DAY).getUTCDay() !== 1) n -= 1;
  return dayStr(n);
}

export function holidaysForYear(y) {
  const s = new Set();
  // Canadian federal statutory.
  s.add(pad(y, 1, 1));
  s.add(dayStr(dayNum(easterSunday(y)) - 2)); // Good Friday
  s.add(pad(y, 7, 1)); // Canada Day
  s.add(nthWeekday(y, 9, 1, 1)); // Labour Day
  s.add(pad(y, 9, 30)); // National Day for Truth and Reconciliation
  s.add(nthWeekday(y, 10, 1, 2)); // Thanksgiving
  s.add(pad(y, 11, 11)); // Remembrance Day
  s.add(pad(y, 12, 25)); // Christmas Day
  s.add(pad(y, 12, 26)); // Boxing Day
  // BC statutory (beyond federal).
  s.add(nthWeekday(y, 2, 1, 3)); // Family Day
  s.add(victoriaDay(y)); // Victoria Day
  s.add(nthWeekday(y, 8, 1, 1)); // BC Day
  // US federal.
  s.add(nthWeekday(y, 1, 1, 3)); // Birthday of Martin Luther King, Jr.
  s.add(nthWeekday(y, 2, 1, 3)); // Washington's Birthday
  s.add(lastWeekday(y, 5, 1)); // Memorial Day
  s.add(pad(y, 6, 19)); // Juneteenth National Independence Day
  s.add(pad(y, 7, 4)); // Independence Day
  s.add(nthWeekday(y, 10, 1, 2)); // Columbus Day
  s.add(nthWeekday(y, 11, 4, 4)); // Thanksgiving Day
  return s;
}

export function isHoliday(ymd) {
  if (typeof ymd !== 'string' || !RE.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return holidaysForYear(y).has(ymd);
}

// A payday on a holiday moves one day earlier; consecutive holidays
// keep stepping back (Dec 26 -> Dec 24, never Dec 25).
export function adjustPayday(ymd) {
  let d = ymd;
  while (isHoliday(d)) d = dayStr(dayNum(d) - 1);
  return d;
}
