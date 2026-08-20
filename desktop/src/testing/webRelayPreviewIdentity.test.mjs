import assert from "node:assert/strict";
import test from "node:test";

import { selectWebRelayPreviewIdentity } from "./webRelayPreviewIdentity.ts";

test("defaults the local relay preview to Tyler", () => {
  assert.equal(
    selectWebRelayPreviewIdentity(new URLSearchParams()).username,
    "tyler",
  );
});

test("selects Alice in an isolated preview browser", () => {
  const identity = selectWebRelayPreviewIdentity(
    new URLSearchParams("previewUser=alice"),
  );

  assert.equal(identity.username, "alice");
  assert.equal(
    identity.pubkey,
    "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
  );
});

test("rejects identities outside the seeded local preview set", () => {
  assert.throws(
    () =>
      selectWebRelayPreviewIdentity(new URLSearchParams("previewUser=mallory")),
    /Unknown local preview user/,
  );
});
