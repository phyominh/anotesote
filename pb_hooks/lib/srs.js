// SM-2 variant scheduler (HANDOVER §8.4). Pure: state in, state out.
// Must stay goja-compatible: CommonJS, no Node-only APIs.

var EASE_DEFAULT = 2.5;
var EASE_FLOOR = 1.3;
var MAX_INTERVAL_DAYS = 365;
var DAY_MS = 24 * 60 * 60 * 1000;
var AGAIN_DELAY_MS = 10 * 60 * 1000;
// Day boundaries are evaluated in Asia/Tokyo, which has no DST.
var TZ_OFFSET_MS = 9 * 60 * 60 * 1000;

function toMs(t) {
  if (t === null || t === undefined || t === "") return null;
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  var ms = Date.parse(String(t).replace(" ", "T"));
  return isNaN(ms) ? null : ms;
}

// Start of the Tokyo calendar day containing `now`, as UTC ms.
function startOfDay(now) {
  var ms = toMs(now);
  return Math.floor((ms + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS;
}

function isSameDay(a, b) {
  var am = toMs(a);
  var bm = toMs(b);
  if (am === null || bm === null) return false;
  return startOfDay(am) === startOfDay(bm);
}

function clampGrade(grade) {
  var g = Math.round(Number(grade));
  if (isNaN(g)) return null;
  return Math.min(4, Math.max(1, g));
}

// HANDOVER §7.3 score → grade table.
function gradeFromScore(score) {
  var s = Number(score);
  if (isNaN(s)) return null;
  if (s < 50) return 1;
  if (s < 70) return 2;
  if (s < 90) return 3;
  return 4;
}

function normaliseState(state) {
  state = state || {};
  var ease = Number(state.ease);
  return {
    interval_days: Number(state.interval_days) || 0,
    ease: ease > 0 ? ease : EASE_DEFAULT,
    reps: Number(state.reps) || 0,
    lapses: Number(state.lapses) || 0,
    due: state.due || null,
    last_reviewed: state.last_reviewed || null,
  };
}

// schedule(state, grade, now) → {interval_days, ease, reps, lapses, due, last_reviewed, advanced}
// `due` and `last_reviewed` are ISO strings. `advanced` is false for same-day repeats.
function schedule(state, grade, now) {
  var s = normaliseState(state);
  var g = clampGrade(grade);
  if (g === null) throw new Error("grade must be a number 1-4");
  var nowMs = toMs(now);
  if (nowMs === null) nowMs = Date.now();
  var nowIso = new Date(nowMs).toISOString();

  // Same-day repeat: log-only for scheduling, except a fail pulls `due` in.
  if (isSameDay(s.last_reviewed, nowMs)) {
    var out = {
      interval_days: s.interval_days,
      ease: s.ease,
      reps: s.reps,
      lapses: s.lapses,
      due: s.due ? new Date(toMs(s.due)).toISOString() : null,
      last_reviewed: nowIso,
      advanced: false,
    };
    if (g === 1) out.due = new Date(nowMs + AGAIN_DELAY_MS).toISOString();
    return out;
  }

  var ease = s.ease;
  var reps = s.reps;
  var lapses = s.lapses;
  var interval = s.interval_days;
  var dueMs;

  if (g === 1) {
    lapses += 1;
    reps = 0;
    ease -= 0.2;
    interval = 0;
    dueMs = nowMs + AGAIN_DELAY_MS;
  } else {
    if (g === 2) {
      ease -= 0.15;
      reps += 1;
      interval = reps === 1 ? 1 : Math.max(1, Math.round(interval * 1.2));
    } else if (g === 3) {
      reps += 1;
      interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(interval * ease);
    } else {
      ease += 0.15;
      reps += 1;
      interval = reps === 1 ? 3 : reps === 2 ? 6 : Math.round(interval * ease * 1.3);
    }
    interval = Math.min(MAX_INTERVAL_DAYS, Math.max(1, interval));
    dueMs = nowMs + interval * DAY_MS;
  }

  ease = Math.max(EASE_FLOOR, Math.round(ease * 1000) / 1000);

  return {
    interval_days: interval,
    ease: ease,
    reps: reps,
    lapses: lapses,
    due: new Date(dueMs).toISOString(),
    last_reviewed: nowIso,
    advanced: true,
  };
}

function initialState() {
  return { interval_days: 0, ease: EASE_DEFAULT, reps: 0, lapses: 0, due: null, last_reviewed: null };
}

module.exports = {
  schedule: schedule,
  initialState: initialState,
  clampGrade: clampGrade,
  gradeFromScore: gradeFromScore,
  startOfDay: startOfDay,
  isSameDay: isSameDay,
  toMs: toMs,
  EASE_FLOOR: EASE_FLOOR,
  MAX_INTERVAL_DAYS: MAX_INTERVAL_DAYS,
};
