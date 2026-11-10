// New Zealand calendar-day helpers.
//
// The server runs in UTC, but Pat lives in NZ (UTC+12 / +13 in summer).
// toISOString() gives the UTC day, which is still "yesterday" in NZ every
// morning until midday or 1pm. These helpers work in Pacific/Auckland instead.
const TZ = 'Pacific/Auckland';

// 'YYYY-MM-DD' for the NZ day an instant falls on (en-CA prints that shape).
function nzYmd(ms = Date.now()) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
}

// How many minutes NZ is ahead of UTC at a given instant (780 in summer, 720 in winter).
function nzOffsetMin(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(ms).map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - (ms - (ms % 1000))) / 60000);
}

// UTC instant of 00:00 NZ on a given 'YYYY-MM-DD'. Guess with the offset at
// UTC midnight, then correct once (handles the daylight-saving switch days).
function nzMidnightMs(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  let ms = base - nzOffsetMin(base) * 60000;
  ms = base - nzOffsetMin(ms) * 60000;
  return ms;
}

// [start, end) of an NZ day as SQLite-style UTC strings 'YYYY-MM-DD HH:MM:SS'.
function nzDayRangeSql(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return [sql(nzMidnightMs(ymd)), sql(nzMidnightMs(next))];
}

module.exports = { nzYmd, nzOffsetMin, nzMidnightMs, nzDayRangeSql };
