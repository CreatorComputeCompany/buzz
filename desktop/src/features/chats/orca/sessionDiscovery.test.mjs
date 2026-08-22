import assert from "node:assert/strict";
import test from "node:test";

import { conversationSuffix, findChatWorktrees } from "./sessionDiscovery.ts";

test("derives Orca's bounded conversation suffix", () => {
  assert.equal(
    conversationSuffix("697c50bf-0c44-40fc-9d56-648133bc401e"),
    "697c50bf0c44",
  );
});

test("finds a chat worktree from Orca's composite id", () => {
  const expected = {
    id: "repo-id::/home/boxd/orca/workspaces/buzz/buzz-orca-697c50bf0c44-1",
    branch: "refs/heads/user/buzz-orca-697c50bf0c44-1",
  };
  assert.deepEqual(
    findChatWorktrees(
      [{ id: "repo-id::/tmp/unrelated" }, expected],
      "697c50bf-0c44-40fc-9d56-648133bc401e",
    ),
    [expected],
  );
});

test("orders matching recovery worktrees newest first", () => {
  const channelId = "697c50bf-0c44-40fc-9d56-648133bc401e";
  const older = { id: "repo::/tmp/buzz-orca-697c50bf0c44-1" };
  const newer = { id: "repo::/tmp/buzz-orca-697c50bf0c44-8" };
  assert.deepEqual(findChatWorktrees([older, newer], channelId), [
    newer,
    older,
  ]);
});
