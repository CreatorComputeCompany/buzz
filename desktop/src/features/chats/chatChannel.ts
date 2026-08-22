import type { Channel } from "@/shared/api/types";

export const ORCA_CHAT_DESCRIPTION_PREFIX = "buzz-orca-chat:v1:";

export type OrcaChatProvider = "codex" | "claude";

export type OrcaChatConfig = {
  agentPubkey: string;
  baseRef: string | null;
  model: string | null;
  provider: OrcaChatProvider;
  repositoryLabel: string;
  repositorySelector: string;
  title: string;
};

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;

export function encodeOrcaChatDescription(config: OrcaChatConfig): string {
  return `${ORCA_CHAT_DESCRIPTION_PREFIX}${JSON.stringify(config)}`;
}

export function parseOrcaChatDescription(
  description: string | null | undefined,
): OrcaChatConfig | null {
  if (!description?.startsWith(ORCA_CHAT_DESCRIPTION_PREFIX)) return null;

  try {
    const value = JSON.parse(
      description.slice(ORCA_CHAT_DESCRIPTION_PREFIX.length),
    ) as Partial<OrcaChatConfig>;
    if (
      !value.agentPubkey ||
      !PUBKEY_PATTERN.test(value.agentPubkey) ||
      (value.baseRef !== undefined &&
        value.baseRef !== null &&
        (typeof value.baseRef !== "string" ||
          !value.baseRef ||
          !SAFE_VALUE_PATTERN.test(value.baseRef))) ||
      (value.provider !== "codex" && value.provider !== "claude") ||
      !value.repositoryLabel?.trim() ||
      !value.repositorySelector ||
      !SAFE_VALUE_PATTERN.test(value.repositorySelector) ||
      !value.title?.trim() ||
      (value.model !== null &&
        (typeof value.model !== "string" ||
          !value.model ||
          !SAFE_VALUE_PATTERN.test(value.model)))
    ) {
      return null;
    }

    return {
      agentPubkey: value.agentPubkey.toLowerCase(),
      baseRef: value.baseRef ?? null,
      model: value.model,
      provider: value.provider,
      repositoryLabel: value.repositoryLabel.trim(),
      repositorySelector: value.repositorySelector,
      title: value.title.trim(),
    };
  } catch {
    return null;
  }
}

export function getOrcaChatConfig(channel: Channel): OrcaChatConfig | null {
  return parseOrcaChatDescription(channel.description);
}

export function isOrcaChatChannel(channel: Channel): boolean {
  return getOrcaChatConfig(channel) !== null;
}

export function getOrcaChatLabel(channel: Channel): string {
  return getOrcaChatConfig(channel)?.title ?? channel.name;
}

export function createOrcaChatChannelName(now = Date.now()): string {
  return `orca-chat-${now.toString(36)}`;
}
