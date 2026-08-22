import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeOrcaChatDescription,
  parseOrcaChatDescription,
} from "./chatChannel.ts";

const config = {
  agentPubkey: "a".repeat(64),
  baseRef: "feat/full-buzz-web",
  model: "gpt-5.6-codex",
  provider: "codex",
  repositoryLabel: "Buzz",
  repositorySelector: "id:repo-1",
  title: "New chat",
};

test("Orca chat descriptions round trip", () => {
  assert.deepEqual(
    parseOrcaChatDescription(encodeOrcaChatDescription(config)),
    config,
  );
});

test("ordinary and unsafe descriptions are rejected", () => {
  assert.equal(parseOrcaChatDescription("ordinary channel"), null);
  assert.equal(
    parseOrcaChatDescription(
      encodeOrcaChatDescription({
        ...config,
        repositorySelector: "id:repo; rm -rf /",
      }),
    ),
    null,
  );
});

test("older Orca chats remain readable without an explicit base ref", () => {
  const { baseRef: _, ...legacyConfig } = config;
  assert.deepEqual(
    parseOrcaChatDescription(encodeOrcaChatDescription(legacyConfig)),
    { ...legacyConfig, baseRef: null },
  );
});
