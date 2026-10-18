// Minimal JSON Schema subset validator for tool inputs. Pure, goja-compatible.
// Supports: type, properties, required, additionalProperties:false, enum,
// minimum/maximum, minLength/maxLength, items, minItems/maxItems.
// Returns null when valid, otherwise a message naming the offending path.

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function validate(schema, value, path) {
  path = path || "arguments";
  if (!schema) return null;
  var t = typeOf(value);
  if (schema.type) {
    var types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(function (x) { return typeMatches(x, t); })) {
      return path + " must be " + types.join(" or ");
    }
  }
  if (schema.enum && schema.enum.indexOf(value) < 0) {
    return path + " must be one of: " + schema.enum.join(", ");
  }
  if (t === "integer" || t === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return path + " must be >= " + schema.minimum;
    if (schema.maximum !== undefined && value > schema.maximum) return path + " must be <= " + schema.maximum;
  }
  if (t === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return path + " must be at least " + schema.minLength + " characters";
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return path + " must be at most " + schema.maxLength + " characters";
  }
  if (t === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) return path + " must have at least " + schema.minItems + " items";
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return path + " must have at most " + schema.maxItems + " items";
    if (schema.items) {
      for (var i = 0; i < value.length; i++) {
        var e = validate(schema.items, value[i], path + "[" + i + "]");
        if (e) return e;
      }
    }
  }
  if (t === "object") {
    var props = schema.properties || {};
    var req = schema.required || [];
    for (var r = 0; r < req.length; r++) {
      if (value[req[r]] === undefined) return path + "." + req[r] + " is required";
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (props[key]) {
        if (value[key] === undefined) continue;
        var err = validate(props[key], value[key], path + "." + key);
        if (err) return err;
      } else if (schema.additionalProperties === false) {
        return path + "." + key + " is not allowed";
      }
    }
  }
  return null;
}

module.exports = { validate: validate };
