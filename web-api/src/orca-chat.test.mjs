import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeOrcaChatBridge,
  mintOrcaChatEmbedToken,
  parseOrcaChatCommandResponse,
  parseOrcaChatChannel,
  parseOrcaChatProfile,
  parseOrcaChatRelayMemberPubkeys,
  verifyOrcaChatEmbedToken,
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
      avatarUrl: null,
    },
  );
  assert.equal(
    parseOrcaChatProfile(event({ content: "invalid" })).displayName,
    "bbbbbbbbbb",
  );
  assert.equal(
    parseOrcaChatProfile(
      event({ content: '{"picture":"https://example.com/bob.png"}' }),
    ).avatarUrl,
    "https://example.com/bob.png",
  );
  assert.equal(
    parseOrcaChatProfile(event({ content: '{"picture":"not a URL"}' }))
      .avatarUrl,
    null,
  );
});

test("parses the existing Buzz relay member directory", () => {
  assert.deepEqual(
    parseOrcaChatRelayMemberPubkeys(
      event({
        tags: [
          ["member", "d".repeat(64), "member"],
          ["p", "e".repeat(64), "", "admin"],
          ["member", "invalid"],
          ["member", "d".repeat(64), "member"],
        ],
      }),
    ),
    ["d".repeat(64), "e".repeat(64)],
  );
});

test("parses Buzz command acknowledgements", () => {
  assert.deepEqual(
    parseOrcaChatCommandResponse(
      'response:{"channel_id":"552a0297-7a76-4f2d-a2d5-d0d8e99a652a"}',
    ),
    { channel_id: "552a0297-7a76-4f2d-a2d5-d0d8e99a652a" },
  );
  assert.throws(() => parseOrcaChatCommandResponse("not json"));
});

test("bridge authorization is constant-time and fails closed", () => {
  assert.equal(authorizeOrcaChatBridge("Bearer secret", "secret"), true);
  assert.equal(authorizeOrcaChatBridge("Bearer nope", "secret"), false);
  assert.equal(authorizeOrcaChatBridge(null, "secret"), false);
  assert.equal(authorizeOrcaChatBridge("Bearer secret", ""), false);
});

test("mints tamper-evident focused-chat tokens for an Orca member", () => {
  const previous = process.env.ORCA_CHAT_BRIDGE_SECRET;
  process.env.ORCA_CHAT_BRIDGE_SECRET = "test-bridge-secret";
  try {
    const actor = {
      controllerId: "controller-1",
      memberKey: "jake",
      displayName: "Jake",
      email: "jake@example.com",
    };
    const token = mintOrcaChatEmbedToken(actor);
    assert.deepEqual(verifyOrcaChatEmbedToken(`Bearer ${token}`), actor);
    assert.equal(
      verifyOrcaChatEmbedToken(`Bearer ${token.slice(0, -1)}x`),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.ORCA_CHAT_BRIDGE_SECRET;
    else process.env.ORCA_CHAT_BRIDGE_SECRET = previous;
  }
});
