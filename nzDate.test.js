// NZ calendar-day helpers (lib/nzDate.js): the Orbit feed uses these so a
// morning workout counts as "today" in NZ, not the UTC day before.
const test = require('node:test');
const assert = require('node:assert');
const { nzYmd, nzDayRangeSql } = require('./lib/nzDate');

test('7am NZ is still the previous day in UTC, but nzYmd says today', () => {
  assert.strictEqual(nzYmd(Date.parse('2026-11-10T18:00:00Z')), '2026-11-11');
});

test('summer day runs 11:00 UTC to 11:00 UTC', () => {
  assert.deepStrictEqual(nzDayRangeSql('2026-11-11'), ['2026-11-10 11:00:00', '2026-11-11 11:00:00']);
});

test('winter day runs 12:00 UTC to 12:00 UTC', () => {
  assert.deepStrictEqual(nzDayRangeSql('2026-07-01'), ['2026-06-30 12:00:00', '2026-07-01 12:00:00']);
});

test('daylight saving days are 25h and 23h long', () => {
  assert.deepStrictEqual(nzDayRangeSql('2026-04-05'), ['2026-04-04 11:00:00', '2026-04-05 12:00:00']);
  assert.deepStrictEqual(nzDayRangeSql('2026-09-27'), ['2026-09-26 12:00:00', '2026-09-27 11:00:00']);
});
