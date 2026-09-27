const { test } = require("node:test");
const assert = require("node:assert");
const calc = require("../calc.js");

test("add", () => assert.strictEqual(calc.add(2, 3), 5));
test("multiply", { skip: typeof calc.multiply !== "function" }, () => assert.strictEqual(calc.multiply(2, 3), 6));
