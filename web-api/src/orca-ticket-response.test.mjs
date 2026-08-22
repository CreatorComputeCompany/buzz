import assert from "node:assert/strict";
import test from "node:test";
import { toOrcaRuntimeResponse } from "./orca-ticket-response.ts";

test("turns a member-scoped ticket into embedded Orca auth", () => {
  assert.deepEqual(
    toOrcaRuntimeResponse({
      pairingUrl: "orca://pair?code=ticket",
      worktreeId: "worktree-1",
      email: "new@example.com",
      member: { key: "member-new", displayName: "New User" },
    }),
    {
      pairingUrl: "orca://pair?code=ticket",
      worktreeId: "worktree-1",
      orcaAuth: {
        pairingUrl: "orca://pair?code=ticket",
        email: "new@example.com",
        member: {
          key: "member-new",
          displayName: "New User",
          deviceIds: [],
        },
      },
    },
  );
});

test("does not invent member auth for a legacy ticket", () => {
  assert.deepEqual(
    toOrcaRuntimeResponse({ pairingUrl: "orca://pair?code=legacy" }),
    { pairingUrl: "orca://pair?code=legacy" },
  );
});
