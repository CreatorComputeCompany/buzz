import type { Event } from "nostr-tools";
import { pool } from "./auth.js";
import {
  decryptFromSelf,
  ensureIdentity,
  ensureRelayMembership,
  ensureRelayProfile,
  promoteIdentityUserId,
  relayPost,
  signTemplate,
  type StoredIdentity,
} from "./identity.js";
import {
  isOrcaChatChannelId,
  mintOrcaChatEmbedToken,
  parseOrcaChatCommandResponse,
  parseOrcaChatChannel,
  parseOrcaChatProfile,
  parseOrcaChatRelayMemberPubkeys,
  stableOrcaChatIdentityKey,
  validOrcaChatActor,
  type OrcaChatChannel,
  type OrcaChatMember,
  type OrcaChatProfile,
} from "./orca-chat-shapes.js";

const MAX_MESSAGE_LENGTH = 100_000;
const HISTORY_LIMIT = 100;
const CHAT_ACTIVITY_KINDS = [9, 40002, 45001, 45003];
const CHAT_ACTIVITY_LIMIT = 5_000;
const READ_STATE_KIND = 30078;

type RelayTag = string[];

export type OrcaChatBootstrap = {
  pubkey: string;
  channels: OrcaChatChannel[];
  profiles: OrcaChatProfile[];
  members: OrcaChatMember[];
};

export type OrcaChatHistory = {
  events: Event[];
  profiles: OrcaChatProfile[];
};

export type OrcaChatSurface = {
  url: string;
};

function tagValue(tags: RelayTag[], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function tagValues(tags: RelayTag[], name: string): string[] {
  return tags.flatMap((tag) => (tag[0] === name && tag[1] ? [tag[1]] : []));
}

async function memberChannels(identity: StoredIdentity): Promise<{
  channels: OrcaChatChannel[];
  memberChannelIds: Set<string>;
}> {
  const memberships = await relayPost<Event[]>(identity, "/query", [
    { kinds: [39002], "#p": [identity.pubkey], limit: 500 },
  ]);
  const membershipByChannel = new Map<string, Event>();
  for (const event of memberships) {
    const id = tagValue(event.tags as RelayTag[], "d");
    if (id && isOrcaChatChannelId(id)) membershipByChannel.set(id, event);
  }
  const memberChannelIds = new Set(membershipByChannel.keys());
  const metadata = await relayPost<Event[]>(identity, "/query", [
    { kinds: [39000], limit: 500 },
  ]);
  const channels = [
    ...new Map(
      metadata
        .map(parseOrcaChatChannel)
        .filter((channel): channel is OrcaChatChannel => channel !== null)
        .filter(
          (channel) =>
            channel.visibility === "open" || memberChannelIds.has(channel.id),
        )
        .map((channel) => {
          const membership = membershipByChannel.get(channel.id);
          const participantPubkeys = membership
            ? tagValues(membership.tags as RelayTag[], "p")
            : [];
          return [
            channel.id,
            channel.type === "dm"
              ? { ...channel, participantPubkeys }
              : channel,
          ] as const;
        }),
    ).values(),
  ];
  return { channels, memberChannelIds };
}

async function assertChannelAccess(
  identity: StoredIdentity,
  channelId: string,
): Promise<{ channel: OrcaChatChannel; isMember: boolean }> {
  const { channels, memberChannelIds } = await memberChannels(identity);
  const channel = channels.find((candidate) => candidate.id === channelId);
  if (!channel) throw new Error("channel_not_accessible");
  return { channel, isMember: memberChannelIds.has(channelId) };
}

function readStateForIdentity(
  identity: StoredIdentity,
  events: Event[],
): Map<string, number> {
  const markers = new Map<string, number>();
  for (const event of events) {
    if (event.pubkey.toLowerCase() !== identity.pubkey.toLowerCase()) continue;
    if (!event.tags.some((tag) => tag[0] === "t" && tag[1] === "read-state")) {
      continue;
    }
    try {
      const payload = JSON.parse(decryptFromSelf(identity, event.content)) as {
        v?: unknown;
        contexts?: unknown;
      };
      if (
        payload.v !== 1 ||
        !payload.contexts ||
        typeof payload.contexts !== "object" ||
        Array.isArray(payload.contexts)
      ) {
        continue;
      }
      for (const [contextId, timestamp] of Object.entries(payload.contexts)) {
        if (
          typeof timestamp === "number" &&
          Number.isInteger(timestamp) &&
          timestamp >= 0
        ) {
          markers.set(
            contextId,
            Math.max(markers.get(contextId) ?? 0, timestamp),
          );
        }
      }
    } catch {
      // A bad or obsolete read-state slot must not hide the conversation list.
    }
  }
  return markers;
}

async function addChannelActivity(
  identity: StoredIdentity,
  channels: OrcaChatChannel[],
  memberChannelIds: Set<string>,
): Promise<OrcaChatChannel[]> {
  if (channels.length === 0 || memberChannelIds.size === 0) return channels;
  const channelIds = [...memberChannelIds];
  const [activityEvents, readStateEvents] = await Promise.all([
    relayPost<Event[]>(identity, "/query", [
      {
        kinds: CHAT_ACTIVITY_KINDS,
        "#h": channelIds,
        limit: CHAT_ACTIVITY_LIMIT,
      },
    ]),
    relayPost<Event[]>(identity, "/query", [
      {
        kinds: [READ_STATE_KIND],
        authors: [identity.pubkey],
        "#t": ["read-state"],
        limit: 500,
      },
    ]),
  ]);
  const readState = readStateForIdentity(identity, readStateEvents);
  const activityByChannel = new Map<
    string,
    { lastActivityAtMs: number; unreadCount: number }
  >();
  for (const event of activityEvents) {
    const channelId = tagValue(event.tags as RelayTag[], "h");
    if (!channelId || !memberChannelIds.has(channelId)) continue;
    const activity = activityByChannel.get(channelId) ?? {
      lastActivityAtMs: 0,
      unreadCount: 0,
    };
    activity.lastActivityAtMs = Math.max(
      activity.lastActivityAtMs,
      event.created_at * 1_000,
    );
    if (
      event.pubkey.toLowerCase() !== identity.pubkey.toLowerCase() &&
      event.created_at > (readState.get(channelId) ?? 0)
    ) {
      activity.unreadCount += 1;
    }
    activityByChannel.set(channelId, activity);
  }
  return channels.map((channel) => ({
    ...channel,
    ...(activityByChannel.get(channel.id) ?? {
      lastActivityAtMs: 0,
      unreadCount: 0,
    }),
  }));
}

export async function identityForOrcaChatActor(
  actorValue: unknown,
): Promise<StoredIdentity> {
  const actor = validOrcaChatActor(actorValue);
  let identityKey = stableOrcaChatIdentityKey(actor);
  let matchedExistingBuzzUser = false;
  if (actor.email) {
    const matched = await pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1',
      [actor.email],
    );
    if (matched.rows[0]?.id) {
      identityKey = matched.rows[0].id;
      matchedExistingBuzzUser = true;
    }
  }
  if (!matchedExistingBuzzUser) {
    await promoteIdentityUserId(
      `orca:${actor.controllerId}:${actor.memberKey}`,
      identityKey,
    );
  }
  const identity = await ensureIdentity(identityKey);
  await ensureRelayMembership(identityKey, identity);
  await ensureRelayProfile(identity, actor.displayName.trim());
  return identity;
}

async function profilesFor(pubkeys: string[], identity: StoredIdentity) {
  const unique = [
    ...new Set(pubkeys.filter((value) => /^[0-9a-f]{64}$/i.test(value))),
  ];
  if (!unique.length) return [];
  const events = await relayPost<Event[]>(identity, "/query", [
    { kinds: [0], authors: unique, limit: unique.length },
  ]);
  return events.map(parseOrcaChatProfile);
}

async function relayMemberPubkeys(identity: StoredIdentity): Promise<string[]> {
  const events = await relayPost<Event[]>(identity, "/query", [
    { kinds: [13534], limit: 1 },
  ]);
  return parseOrcaChatRelayMemberPubkeys(events[0]);
}

async function memberDirectory(
  identity: StoredIdentity,
): Promise<OrcaChatMember[]> {
  const pubkeys = await relayMemberPubkeys(identity);
  const profiles = await profilesFor(pubkeys, identity);
  const profilesByPubkey = new Map(
    profiles.map((profile) => [profile.pubkey.toLowerCase(), profile]),
  );
  return pubkeys.map(
    (pubkey) =>
      profilesByPubkey.get(pubkey) ?? {
        pubkey,
        displayName: pubkey.slice(0, 10),
        avatarUrl: null,
      },
  );
}

export async function bootstrapOrcaChat(
  actorValue: unknown,
): Promise<OrcaChatBootstrap> {
  const identity = await identityForOrcaChatActor(actorValue);
  const [{ channels, memberChannelIds }, members] = await Promise.all([
    memberChannels(identity),
    memberDirectory(identity),
  ]);
  const channelsWithActivity = await addChannelActivity(
    identity,
    channels,
    memberChannelIds,
  );
  return {
    pubkey: identity.pubkey,
    channels: channelsWithActivity,
    profiles: members,
    members,
  };
}

export async function openOrcaChatDm(
  actorValue: unknown,
  participantPubkeysValue: unknown,
): Promise<OrcaChatChannel> {
  if (
    !Array.isArray(participantPubkeysValue) ||
    participantPubkeysValue.length < 1 ||
    participantPubkeysValue.length > 8
  ) {
    throw new Error("invalid_participants");
  }
  const participantPubkeys = [
    ...new Set(
      participantPubkeysValue.map((value) =>
        typeof value === "string" ? value.toLowerCase() : "",
      ),
    ),
  ];
  if (participantPubkeys.some((pubkey) => !/^[0-9a-f]{64}$/.test(pubkey))) {
    throw new Error("invalid_participants");
  }

  const identity = await identityForOrcaChatActor(actorValue);
  if (participantPubkeys.includes(identity.pubkey.toLowerCase())) {
    throw new Error("invalid_participants");
  }
  const relayMembers = new Set(await relayMemberPubkeys(identity));
  if (participantPubkeys.some((pubkey) => !relayMembers.has(pubkey))) {
    throw new Error("invalid_participants");
  }

  const event = signTemplate(identity, {
    kind: 41010,
    content: "",
    tags: participantPubkeys.map((pubkey) => ["p", pubkey]),
  });
  const acknowledgement = await relayPost<{ message?: unknown }>(
    identity,
    "/events",
    event,
  );
  const response = parseOrcaChatCommandResponse(acknowledgement.message);
  const channelId = response.channel_id;
  if (!isOrcaChatChannelId(channelId)) {
    throw new Error("invalid_relay_response");
  }

  const metadata = await relayPost<Event[]>(identity, "/query", [
    { kinds: [39000], "#d": [channelId], limit: 1 },
  ]);
  const channel = metadata[0] ? parseOrcaChatChannel(metadata[0]) : null;
  if (!channel) throw new Error("dm_metadata_unavailable");
  return {
    ...channel,
    type: "dm",
    visibility: "private",
    participantPubkeys: [identity.pubkey.toLowerCase(), ...participantPubkeys],
  };
}

export async function getOrcaChatHistory(
  actorValue: unknown,
  channelId: unknown,
): Promise<OrcaChatHistory> {
  if (!isOrcaChatChannelId(channelId)) {
    throw new Error("invalid_channel");
  }
  const identity = await identityForOrcaChatActor(actorValue);
  await assertChannelAccess(identity, channelId);
  const events = await relayPost<Event[]>(identity, "/query", [
    { kinds: [9], "#h": [channelId], limit: HISTORY_LIMIT },
  ]);
  const profiles = await profilesFor(
    events.map((event) => event.pubkey),
    identity,
  );
  return { events, profiles };
}

export async function createOrcaChatSurface(
  actorValue: unknown,
  channelId: unknown,
): Promise<OrcaChatSurface> {
  if (!isOrcaChatChannelId(channelId)) {
    throw new Error("invalid_channel");
  }
  const actor = validOrcaChatActor(actorValue);
  const identity = await identityForOrcaChatActor(actor);
  await assertChannelAccess(identity, channelId);
  const token = mintOrcaChatEmbedToken(actor);
  const baseUrl = process.env.BETTER_AUTH_URL;
  if (!baseUrl) throw new Error("user_chat_not_configured");
  const url = new URL(baseUrl);
  url.searchParams.set("orcaFocused", "1");
  url.searchParams.set("orcaEmbed", token);
  url.hash = `/channels/${encodeURIComponent(channelId)}`;
  return { url: url.toString() };
}

export async function sendOrcaChatMessage(
  actorValue: unknown,
  channelId: unknown,
  content: unknown,
): Promise<Event> {
  if (!isOrcaChatChannelId(channelId)) {
    throw new Error("invalid_channel");
  }
  if (
    typeof content !== "string" ||
    !content.trim() ||
    content.length > MAX_MESSAGE_LENGTH
  ) {
    throw new Error("invalid_message");
  }
  const identity = await identityForOrcaChatActor(actorValue);
  const access = await assertChannelAccess(identity, channelId);
  if (!access.isMember && access.channel.visibility === "open") {
    const joinEvent = signTemplate(identity, {
      kind: 9021,
      content: "",
      tags: [["h", channelId]],
    });
    await relayPost(identity, "/events", joinEvent);
  }
  const event = signTemplate(identity, {
    kind: 9,
    content: content.trim(),
    tags: [["h", channelId]],
  });
  await relayPost(identity, "/events", event);
  return event;
}
