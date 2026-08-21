import type { Channel } from "@/shared/api/types";
import { isOrcaChatChannel } from "@/features/chats/chatChannel";

export function getChannelDescription(channel: Channel | null): string {
  if (!channel) {
    return "Connect to the relay to browse channels and read messages.";
  }

  if (isOrcaChatChannel(channel)) {
    return "Private Orca worktree chat.";
  }

  const prefixes = [
    channel.archivedAt ? "Archived." : null,
    !channel.isMember ? "Read-only until you join this open channel." : null,
  ].filter((value) => value && value.trim().length > 0);

  // Show only the first non-empty field to avoid duplication when
  // topic, description, and purpose contain overlapping text.
  const detail = [channel.topic, channel.description, channel.purpose].find(
    (value) => value && value.trim().length > 0,
  );

  const parts = [...prefixes, detail ?? null].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "Channel details and activity.";
}
