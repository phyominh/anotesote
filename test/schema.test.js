const test = require("node:test");
const assert = require("node:assert/strict");
const { validate } = require("../pb_hooks/lib/schema.js");

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["project", "items"],
  properties: {
    project: { type: "string", enum: ["dsa", "japanese"] },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    items: {
      type: "array", minItems: 1, maxItems: 2,
      items: { type: "object", additionalProperties: false, required: ["grade"], properties: { grade: { type: "number" } } },
    },
    meta: { type: "object" },
  },
};

test("valid input passes", () => {
  assert.equal(validate(schema, { project: "dsa", items: [{ grade: 3 }], meta: { any: { nested: 1 } } }), null);
});

test("errors name the path", () => {
  assert.equal(validate(schema, { items: [{ grade: 1 }] }), "arguments.project is required");
  assert.equal(validate(schema, { project: "x", items: [{ grade: 1 }] }), "arguments.project must be one of: dsa, japanese");
  assert.equal(validate(schema, { project: "dsa", items: [] }), "arguments.items must have at least 1 items");
  assert.equal(validate(schema, { project: "dsa", items: [{ grade: "3" }] }), "arguments.items[0].grade must be number");
  assert.equal(validate(schema, { project: "dsa", items: [{ grade: 3, x: 1 }] }), "arguments.items[0].x is not allowed");
  assert.equal(validate(schema, { project: "dsa", items: [{ grade: 3 }], limit: 1.5 }), "arguments.limit must be integer");
  assert.equal(validate(schema, { project: "dsa", items: [{ grade: 3 }], limit: 101 }), "arguments.limit must be <= 100");
  assert.equal(validate(schema, { project: "dsa", items: [{ grade: 3 }], bogus: true }), "arguments.bogus is not allowed");
});
