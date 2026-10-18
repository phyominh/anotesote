// Mastery maths (HANDOVER §8.5). Pure functions, goja-compatible.

var ALPHA = 0.3;
var CARD_WEIGHT = 0.7;
var SELF_WEIGHT = 0.3;

// Normalised grade: 1→0, 2→0.33, 3→0.67, 4→1.
function normGrade(grade) {
  return (Number(grade) - 1) / 3;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

// EMA update. `reviewCount` is the number of reviews before this one;
// the first review sets mastery to g outright.
function ema(prev, grade, reviewCount) {
  var g = normGrade(grade);
  if (!reviewCount) return round4(g);
  var m = Number(prev) || 0;
  return round4(m + ALPHA * (g - m));
}

// Topic mastery from the direct cards' average (reviewed cards only) and
// the topic's own EMA. Either may be null/undefined when absent.
function blendTopic(cardAvg, selfMastery) {
  var hasCards = cardAvg !== null && cardAvg !== undefined && !isNaN(cardAvg);
  var hasSelf = selfMastery !== null && selfMastery !== undefined && !isNaN(selfMastery);
  if (hasCards && hasSelf) return round4(CARD_WEIGHT * cardAvg + SELF_WEIGHT * selfMastery);
  if (hasCards) return round4(cardAvg);
  if (hasSelf) return round4(selfMastery);
  return 0;
}

// Read-time rollup over a topic tree.
// topics: [{id, parent, mastery, card_count, reviewed}] where `reviewed` is
// true if the topic or any of its direct cards has been graded.
// Returns {id: rolled_mastery}. Weighted by card count (min 1 per reviewed
// topic so card-less topics graded directly still contribute); topics with
// no reviews anywhere in their subtree roll up to 0.
function rollup(topics) {
  var children = {};
  var byId = {};
  topics.forEach(function (t) {
    byId[t.id] = t;
    var p = t.parent || "";
    (children[p] = children[p] || []).push(t.id);
  });
  var memo = {};
  function visit(id) {
    if (memo[id]) return memo[id];
    var t = byId[id];
    var w = t.reviewed ? Math.max(1, Number(t.card_count) || 0) : 0;
    var sum = w * (Number(t.mastery) || 0);
    var weight = w;
    (children[id] || []).forEach(function (cid) {
      var r = visit(cid);
      sum += r.sum;
      weight += r.weight;
    });
    memo[id] = { sum: sum, weight: weight };
    return memo[id];
  }
  var out = {};
  topics.forEach(function (t) {
    var r = visit(t.id);
    out[t.id] = r.weight > 0 ? round4(r.sum / r.weight) : 0;
  });
  return out;
}

module.exports = {
  normGrade: normGrade,
  ema: ema,
  blendTopic: blendTopic,
  rollup: rollup,
  ALPHA: ALPHA,
};
