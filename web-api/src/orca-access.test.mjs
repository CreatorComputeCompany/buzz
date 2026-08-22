import assert from "node:assert/strict";
import test from "node:test";
import { isOrcaRuntimeUserAllowed } from "./orca-access.ts";

test("authenticated mode admits every signed-in Buzz user", () => {
  assert.equal(
    isOrcaRuntimeUserAllowed("new-user", {
      BUZZ_ORCA_ACCESS_MODE: "authenticated",
    }),
    true,
  );
});

test("allowlist mode admits only configured user ids", () => {
  const environment = {
    BUZZ_ORCA_ACCESS_MODE: "allowlist",
    BUZZ_ORCA_ALLOWED_USER_IDS: "jake, bob ",
  };
  assert.equal(isOrcaRuntimeUserAllowed("bob", environment), true);
  assert.equal(isOrcaRuntimeUserAllowed("mallory", environment), false);
});

test("missing and invalid modes fail closed", () => {
  assert.equal(isOrcaRuntimeUserAllowed("user", {}), false);
  assert.equal(
    isOrcaRuntimeUserAllowed("user", {
      BUZZ_ORCA_ACCESS_MODE: "public",
      BUZZ_ORCA_ALLOWED_USER_IDS: "user",
    }),
    false,
  );
});
