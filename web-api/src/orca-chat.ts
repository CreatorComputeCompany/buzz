import type { Event } from "nostr-tools";
import { pool } from "./auth.js";
import {
  ensureIdentity,
  ensureRelayMembership,
  ensureRelayProfile,
  relayPost,
  signTemplate,
  type StoredIdentity,
} from "./identity.js";
import {
  isOrcaChatChannelId,
  parseOrcaChatCommandResponse,
  parseOrcaChatChannel,
  parseOrcaChatProfile,
  parseOrcaChatRelayMemberPubkeys,
  validOrcaChatActor,
  type OrcaChatChannel,
  type OrcaChatMember,
  type OrcaChatProfile,
} from "./orca-chat-shapes.js";

const MAX_MESSAGE_LENGTH = 100_000;
const HISTORY_LIMIT = 100;

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

async function identityForActor(actorValue: unknown): Promise<StoredIdentity> {
  const actor = validOrcaChatActor(actorValue);
  let identityKey = `orca:${actor.controllerId}:${actor.memberKey}`;
  if (actor.email) {
    const matched = await pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1',
      [actor.email],
    );
    if (matched.rows[0]?.id) identityKey = matched.rows[0].id;
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
  const identity = await identityForActor(actorValue);
  const [{ channels }, members] = await Promise.all([
    memberChannels(identity),
    memberDirectory(identity),
  ]);
  return { pubkey: identity.pubkey, channels, profiles: members, members };
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

  const identity = await identityForActor(actorValue);
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
  const identity = await identityForActor(actorValue);
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
  const identity = await identityForActor(actorValue);
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
