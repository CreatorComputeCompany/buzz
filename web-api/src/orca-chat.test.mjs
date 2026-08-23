import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeOrcaChatBridge,
  parseOrcaChatChannel,
  parseOrcaChatProfile,
} from "./orca-chat-shapes.ts";

function event(overrides = {}) {
  return {
    id: "a".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1,
    kind: 39000,
    tags: [],
    content: "",
    sig: "c".repeat(128),
    ...overrides,
  };
}

test("parses channels and DMs from Buzz metadata", () => {
  const id = "552a0297-7a76-4f2d-a2d5-d0d8e99a652a";
  assert.deepEqual(
    parseOrcaChatChannel(
      event({
        tags: [
          ["d", id],
          ["name", "general"],
          ["t", "stream"],
        ],
      }),
    ),
    {
      id,
      name: "general",
      type: "channel",
      visibility: "open",
      participantPubkeys: [],
    },
  );
  assert.deepEqual(
    parseOrcaChatChannel(
      event({ tags: [["d", id], ["hidden"], ["p", "d".repeat(64)]] }),
    ),
    {
      id,
      name: "",
      type: "dm",
      visibility: "private",
      participantPubkeys: ["d".repeat(64)],
    },
  );
});

test("uses profile display names with a pubkey fallback", () => {
  assert.deepEqual(
    parseOrcaChatProfile(event({ content: '{"display_name":"Bob"}' })),
    {
      pubkey: "b".repeat(64),
      displayName: "Bob",
    },
  );
  assert.equal(
    parseOrcaChatProfile(event({ content: "invalid" })).displayName,
    "bbbbbbbbbb",
  );
});

test("bridge authorization is constant-time and fails closed", () => {
  assert.equal(authorizeOrcaChatBridge("Bearer secret", "secret"), true);
  assert.equal(authorizeOrcaChatBridge("Bearer nope", "secret"), false);
  assert.equal(authorizeOrcaChatBridge(null, "secret"), false);
  assert.equal(authorizeOrcaChatBridge("Bearer secret", ""), false);
});
