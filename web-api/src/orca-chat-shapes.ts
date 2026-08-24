import { createHmac, timingSafeEqual } from "node:crypto";
import type { Event } from "nostr-tools";

const CHANNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMBER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type OrcaChatActor = {
  controllerId: string;
  memberKey: string;
  displayName: string;
  email?: string;
};

type RelayTag = string[];

export type OrcaChatChannel = {
  id: string;
  name: string;
  type: "channel" | "dm";
  visibility: "open" | "private";
  participantPubkeys: string[];
  lastActivityAtMs: number;
  unreadCount: number;
};

export type OrcaChatProfile = {
  pubkey: string;
  displayName: string;
  avatarUrl: string | null;
};

export type OrcaChatMember = OrcaChatProfile;

const EMBED_TOKEN_VERSION = 1;
const EMBED_TOKEN_TTL_SECONDS = 60 * 60;

type OrcaChatEmbedClaims = {
  v: typeof EMBED_TOKEN_VERSION;
  actor: OrcaChatActor;
  exp: number;
};

function tagValue(tags: RelayTag[], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function tagValues(tags: RelayTag[], name: string): string[] {
  return tags.flatMap((tag) => (tag[0] === name && tag[1] ? [tag[1]] : []));
}

export function isOrcaChatChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID_PATTERN.test(value);
}

export function parseOrcaChatChannel(event: Event): OrcaChatChannel | null {
  const id = tagValue(event.tags as RelayTag[], "d");
  if (!isOrcaChatChannelId(id)) return null;
  const tags = event.tags as RelayTag[];
  const channelType = tagValue(tags, "t");
  const isDm = channelType === "dm" || tags.some((tag) => tag[0] === "hidden");
  const isPrivate =
    isDm ||
    tagValue(tags, "visibility") === "private" ||
    tags.some((tag) => tag[0] === "private");
  return {
    id,
    name: tagValue(tags, "name") ?? "",
    type: isDm ? "dm" : "channel",
    visibility: isPrivate ? "private" : "open",
    participantPubkeys: isDm ? tagValues(tags, "p") : [],
    lastActivityAtMs: 0,
    unreadCount: 0,
  };
}

export function stableOrcaChatIdentityKey(actorValue: unknown): string {
  const actor = validOrcaChatActor(actorValue);
  return `orca-member:${actor.memberKey}`;
}

export function parseOrcaChatProfile(event: Event): OrcaChatProfile {
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    // A malformed optional profile should not hide its messages.
  }
  const displayName =
    (typeof content.display_name === "string" && content.display_name.trim()) ||
    (typeof content.name === "string" && content.name.trim()) ||
    event.pubkey.slice(0, 10);
  let avatarUrl: string | null = null;
  if (typeof content.picture === "string") {
    try {
      const parsed = new URL(content.picture.trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        avatarUrl = parsed.toString();
      }
    } catch {
      // Invalid optional avatar URLs should not break the member directory.
    }
  }
  return { pubkey: event.pubkey, displayName, avatarUrl };
}

export function parseOrcaChatRelayMemberPubkeys(
  event: Event | undefined,
): string[] {
  if (!event) return [];
  const tags = event.tags as RelayTag[];
  return [
    ...new Set(
      tags.flatMap((tag) => {
        const pubkey =
          tag[0] === "member" ? tag[1] : tag[0] === "p" ? tag[1] : undefined;
        return pubkey && /^[0-9a-f]{64}$/i.test(pubkey)
          ? [pubkey.toLowerCase()]
          : [];
      }),
    ),
  ];
}

export function parseOrcaChatCommandResponse(
  message: unknown,
): Record<string, unknown> {
  if (typeof message !== "string") throw new Error("invalid_relay_response");
  const payload = message.startsWith("response:")
    ? message.slice("response:".length)
    : message;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_relay_response");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("invalid_relay_response");
  }
}

export function validOrcaChatActor(value: unknown): OrcaChatActor {
  if (!value || typeof value !== "object") throw new Error("invalid_actor");
  const actor = value as Partial<OrcaChatActor>;
  if (
    typeof actor.controllerId !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,160}$/.test(actor.controllerId) ||
    typeof actor.memberKey !== "string" ||
    !MEMBER_KEY_PATTERN.test(actor.memberKey) ||
    typeof actor.displayName !== "string" ||
    !actor.displayName.trim() ||
    actor.displayName.length > 80 ||
    (actor.email !== undefined &&
      (typeof actor.email !== "string" || actor.email.length > 254))
  ) {
    throw new Error("invalid_actor");
  }
  return actor as OrcaChatActor;
}

function embedTokenSignature(payload: string): string {
  const secret = process.env.ORCA_CHAT_BRIDGE_SECRET;
  if (!secret) throw new Error("user_chat_not_configured");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintOrcaChatEmbedToken(actorValue: unknown): string {
  const claims: OrcaChatEmbedClaims = {
    v: EMBED_TOKEN_VERSION,
    actor: validOrcaChatActor(actorValue),
    exp: Math.floor(Date.now() / 1000) + EMBED_TOKEN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${embedTokenSignature(payload)}`;
}

export function verifyOrcaChatEmbedToken(
  authorization: string | null,
): OrcaChatActor | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  if (token.length > 4096) return null;
  const [payload, observedSignature, extra] = token.split(".");
  if (!payload || !observedSignature || extra) return null;
  const wantedSignature = embedTokenSignature(payload);
  const observed = Buffer.from(observedSignature);
  const wanted = Buffer.from(wantedSignature);
  if (observed.length !== wanted.length || !timingSafeEqual(observed, wanted)) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<OrcaChatEmbedClaims>;
    if (
      claims.v !== EMBED_TOKEN_VERSION ||
      typeof claims.exp !== "number" ||
      claims.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return validOrcaChatActor(claims.actor);
  } catch {
    return null;
  }
}

export function authorizeOrcaChatBridge(
  authorization: string | null,
  expected = process.env.ORCA_CHAT_BRIDGE_SECRET,
): boolean {
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const observed = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return observed.length === wanted.length && timingSafeEqual(observed, wanted);
}
