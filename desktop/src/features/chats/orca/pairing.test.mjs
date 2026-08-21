import assert from "node:assert/strict";
import test from "node:test";

import { parseOrcaPairingInput } from "./pairing.ts";

function pairingUrl(overrides = {}) {
  const offer = {
    v: 2,
    endpoint: "https://runtime.example.com",
    deviceToken: "device-token",
    publicKeyB64: "server-public-key",
    scope: "mobile",
    ...overrides,
  };
  const code = Buffer.from(JSON.stringify(offer)).toString("base64url");
  return `orca://pair?code=${code}`;
}

test("parses and normalizes an automatic Orca runtime offer", () => {
  assert.deepEqual(parseOrcaPairingInput(pairingUrl()), {
    v: 2,
    endpoint: "wss://runtime.example.com",
    deviceToken: "device-token",
    publicKeyB64: "server-public-key",
    scope: "mobile",
  });
});

test("rejects an incomplete automatic Orca runtime offer", () => {
  assert.equal(parseOrcaPairingInput(pairingUrl({ deviceToken: "" })), null);
});
