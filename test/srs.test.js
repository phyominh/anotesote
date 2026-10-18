const test = require("node:test");
const assert = require("node:assert/strict");
const srs = require("../pb_hooks/lib/srs.js");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T00:00:00Z"); // 09:00 Tokyo

function days(iso, from) {
  return (Date.parse(iso) - from) / DAY;
}

test("new card graded good three times: 1, 3, ~8 days", () => {
  let s = srs.initialState();
  let now = T0;
  const intervals = [];
  for (let i = 0; i < 3; i++) {
    s = srs.schedule(s, 3, now);
    intervals.push(s.interval_days);
    assert.equal(days(s.due, now), s.interval_days);
    now += s.interval_days * DAY;
  }
  assert.deepEqual(intervals, [1, 3, 8]);
});

test("grade 1 resets reps, increments lapses, due in 10 minutes", () => {
  let s = srs.initialState();
  s = srs.schedule(s, 3, T0);
  s = srs.schedule(s, 3, T0 + DAY);
  const r = srs.schedule(s, 1, T0 + 5 * DAY);
  assert.equal(r.reps, 0);
  assert.equal(r.lapses, 1);
  assert.equal(r.interval_days, 0);
  assert.equal(Date.parse(r.due) - (T0 + 5 * DAY), 10 * 60 * 1000);
});

test("ease never drops below 1.3", () => {
  let s = srs.initialState();
  for (let i = 0; i < 20; i++) s = srs.schedule(s, 1, T0 + i * DAY);
  assert.equal(s.ease, srs.EASE_FLOOR);
  for (let i = 20; i < 40; i++) s = srs.schedule(s, 2, T0 + i * DAY);
  assert.equal(s.ease, srs.EASE_FLOOR);
});

test("interval is capped at 365 days", () => {
  let s = srs.initialState();
  let now = T0;
  for (let i = 0; i < 12; i++) {
    s = srs.schedule(s, 4, now);
    now += s.interval_days * DAY;
  }
  assert.equal(s.interval_days, 365);
  assert.equal(days(s.due, now - 365 * DAY), 365);
});

test("same-day repeat only advances on the first review", () => {
  let s = srs.initialState();
  const first = srs.schedule(s, 3, T0);
  assert.equal(first.advanced, true);
  const second = srs.schedule(first, 4, T0 + 60 * 60 * 1000);
  assert.equal(second.advanced, false);
  assert.equal(second.reps, first.reps);
  assert.equal(second.interval_days, first.interval_days);
  assert.equal(second.due, first.due);
  // a same-day fail pulls due in but does not count as a lapse
  const fail = srs.schedule(second, 1, T0 + 2 * 60 * 60 * 1000);
  assert.equal(fail.advanced, false);
  assert.equal(fail.lapses, 0);
  assert.equal(Date.parse(fail.due) - (T0 + 2 * 60 * 60 * 1000), 10 * 60 * 1000);
});

test("day boundary is Tokyo midnight (15:00 UTC)", () => {
  const before = Date.parse("2026-10-01T14:59:00Z"); // 23:59 JST
  const after = Date.parse("2026-10-01T15:01:00Z"); // 00:01 JST next day
  assert.equal(srs.isSameDay(before, after), false);
  assert.equal(srs.isSameDay(Date.parse("2026-10-01T15:00:00Z"), Date.parse("2026-10-02T14:59:59Z")), true);
  // PocketBase date strings use a space separator
  assert.equal(srs.isSameDay("2026-10-01 16:00:00.000Z", after), true);
  const s = srs.schedule(srs.schedule(srs.initialState(), 3, before), 3, after);
  assert.equal(s.reps, 2);
});

test("score to grade mapping and clamping", () => {
  assert.equal(srs.gradeFromScore(49), 1);
  assert.equal(srs.gradeFromScore(50), 2);
  assert.equal(srs.gradeFromScore(69), 2);
  assert.equal(srs.gradeFromScore(70), 3);
  assert.equal(srs.gradeFromScore(85), 3);
  assert.equal(srs.gradeFromScore(90), 4);
  assert.equal(srs.clampGrade(0), 1);
  assert.equal(srs.clampGrade(7), 4);
  assert.equal(srs.clampGrade(2.6), 3);
  assert.equal(srs.clampGrade("x"), null);
});
