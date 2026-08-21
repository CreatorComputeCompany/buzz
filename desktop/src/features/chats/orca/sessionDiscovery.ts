export type OrcaWorktree = {
  id: string;
  name?: string;
  path?: string;
  branch?: string;
};

export type OrcaTerminal = {
  handle: string;
  title?: string;
  kind?: string;
  connected?: boolean;
};

export function conversationSuffix(channelId: string): string {
  return channelId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
}

export function findChatWorktrees(
  worktrees: OrcaWorktree[],
  channelId: string,
): OrcaWorktree[] {
  const suffix = conversationSuffix(channelId).toLowerCase();
  return worktrees
    .filter((worktree) =>
      [worktree.id, worktree.name, worktree.path, worktree.branch].some(
        (value) => value?.toLowerCase().includes(suffix),
      ),
    )
    .reverse();
}
