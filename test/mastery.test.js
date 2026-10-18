const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../pb_hooks/lib/mastery.js");

test("normalised grade", () => {
  assert.equal(m.normGrade(1), 0);
  assert.equal(m.normGrade(4), 1);
  assert.ok(Math.abs(m.normGrade(3) - 2 / 3) < 1e-9);
});

test("EMA: first review sets mastery to g, later reviews move 30% toward g", () => {
  assert.equal(m.ema(0, 3, 0), 0.6667);
  assert.equal(m.ema(0.5, 4, 1), 0.65);
  assert.equal(m.ema(0.5, 1, 1), 0.35);
  let x = 0;
  for (let i = 0; i < 50; i++) x = m.ema(x, 4, i);
  assert.ok(x > 0.999);
});

test("topic blend: 70/30 when both, single source otherwise, 0 when none", () => {
  assert.equal(m.blendTopic(0.8, 0.5), 0.71);
  assert.equal(m.blendTopic(0.8, null), 0.8);
  assert.equal(m.blendTopic(null, 0.5), 0.5);
  assert.equal(m.blendTopic(null, undefined), 0);
  assert.equal(m.blendTopic(0, null), 0);
});

test("rollup weights by card count and ignores unreviewed subtrees", () => {
  const r = m.rollup([
    { id: "root", parent: "", mastery: 0, card_count: 0, reviewed: false },
    { id: "a", parent: "root", mastery: 0.9, card_count: 3, reviewed: true },
    { id: "b", parent: "root", mastery: 0.3, card_count: 1, reviewed: true },
    { id: "c", parent: "root", mastery: 0, card_count: 5, reviewed: false },
    { id: "a1", parent: "a", mastery: 0.5, card_count: 1, reviewed: true },
  ]);
  assert.equal(r.a1, 0.5);
  assert.equal(r.a, 0.8); // (0.9*3 + 0.5*1) / 4
  assert.equal(r.b, 0.3);
  assert.equal(r.c, 0);
  assert.equal(r.root, 0.7); // (2.7 + 0.5 + 0.3) / 5
});

test("rollup: card-less topic graded directly still counts", () => {
  const r = m.rollup([
    { id: "p", parent: null, mastery: 0, card_count: 0, reviewed: false },
    { id: "q", parent: "p", mastery: 0.6, card_count: 0, reviewed: true },
  ]);
  assert.equal(r.p, 0.6);
});
