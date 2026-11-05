/**
 * Tests for the identity rules of the WebSocket server.
 *
 * These run on Node 18+ (`node --test tests/`), which is not the runtime image's version: the image
 * only runs the server. The point is to pin the rules that a running process cannot show you —
 * a socket that authenticates as somebody it does not own looks exactly like a working one.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const auth = require(path.join(__dirname, "..", "sources", "lib", "auth.js"));

const ALICE = {
  id: "alice@example.com",
  login: "alice",
  privileges: ["A1"],
  firstname: "Alice",
};

test("loginKeys keeps the identity fields, once each", () => {
  assert.deepStrictEqual(auth.loginKeys({ id: "a@b.c", login: "a", user: "a@b.c" }), ["a@b.c", "a"]);
  assert.deepStrictEqual(auth.loginKeys({ login: "  " }), []);
  assert.deepStrictEqual(auth.loginKeys(null), []);
  assert.deepStrictEqual(auth.loginKeys({ id: 42 }), []); // a number is not an identity
});

test("tokenKey addresses the store the API writes", () => {
  assert.strictEqual(auth.tokenKey("abc"), "nyx_tok_abc");
  assert.strictEqual(auth.tokenKey(""), "nyx_tok_");
});

test("identityMatches accepts the account the token belongs to", () => {
  assert.strictEqual(auth.identityMatches(JSON.stringify(ALICE), ["alice@example.com"]), true);
  assert.strictEqual(auth.identityMatches(JSON.stringify(ALICE), ["alice"]), true);
  assert.strictEqual(auth.identityMatches(ALICE, ["ALICE@EXAMPLE.COM"]), true); // case-insensitive
});

test("identityMatches rejects another account", () => {
  // The whole point: a valid token of one's own must not let a client speak for somebody else.
  assert.strictEqual(auth.identityMatches(JSON.stringify(ALICE), ["bob@example.com"]), false);
  assert.strictEqual(auth.identityMatches(JSON.stringify(ALICE), ["bob"]), false);
});

test("identityMatches rejects what it cannot read", () => {
  assert.strictEqual(auth.identityMatches(null, ["alice"]), false);
  assert.strictEqual(auth.identityMatches(JSON.stringify(ALICE), []), false);
  assert.strictEqual(auth.identityMatches("not json", ["alice"]), false);
  assert.strictEqual(auth.identityMatches("null", ["alice"]), false);
});

test("redact removes the values that would be replayable", () => {
  const message = JSON.stringify({ token: "e5b0c1", user: { id: "alice@example.com", password: "x" } });
  const line = auth.redact(message);
  assert.ok(!line.includes("e5b0c1"), "token survived: " + line);
  assert.ok(!/"password":"x"/.test(line), "password survived: " + line);
  assert.ok(line.includes("alice@example.com"), "the account should stay readable");
});

test("redact leaves ordinary payloads alone", () => {
  const payload = '{"type":"message","data":{"value":42}}';
  assert.strictEqual(auth.redact(payload), payload);
});

test("redact handles bearer headers", () => {
  assert.ok(!auth.redact("Authorization: Bearer abc.def-ghi").includes("abc.def-ghi"));
});
