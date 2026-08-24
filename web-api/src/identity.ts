import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { pool } from "./auth.js";

const RELAY_HTTP_URL = "https://imabird-buzz-relay.fly.dev";
export const RELAY_WS_URL = "wss://imabird-buzz-relay.fly.dev";

export type StoredIdentity = {
  pubkey: string;
  encryptedSecret: string;
  relayJoined: boolean;
};

export type EventTemplate = {
  kind: number;
  content: string;
  createdAt?: number;
  tags: string[][];
};

async function ensureIdentityTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_identity (
      user_id TEXT PRIMARY KEY,
      pubkey TEXT NOT NULL UNIQUE,
      encrypted_secret TEXT NOT NULL,
      relay_joined BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function encryptionKey(): Buffer {
  const encoded = process.env.IMABIRD_IDENTITY_ENCRYPTION_KEY;
  if (!encoded) throw new Error("IMABIRD_IDENTITY_ENCRYPTION_KEY is required");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error(
      "IMABIRD_IDENTITY_ENCRYPTION_KEY must contain 32 base64-encoded bytes",
    );
  }
  return key;
}

function encryptSecret(secret: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}

function decryptSecret(value: string): Uint8Array {
  const payload = Buffer.from(value, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(
    Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]),
  );
}

export function decryptFromSelf(
  identity: StoredIdentity,
  ciphertext: string,
): string {
  const secret = decryptSecret(identity.encryptedSecret);
  const conversationKey = nip44.v2.utils.getConversationKey(
    secret,
    identity.pubkey,
  );
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

export async function ensureIdentity(userId: string): Promise<StoredIdentity> {
  await ensureIdentityTable();

  const current = await pool.query<{
    pubkey: string;
    encrypted_secret: string;
    relay_joined: boolean;
  }>(
    "SELECT pubkey, encrypted_secret, relay_joined FROM web_identity WHERE user_id = $1",
    [userId],
  );
  const existing = current.rows[0];
  if (existing) {
    return {
      pubkey: existing.pubkey,
      encryptedSecret: existing.encrypted_secret,
      relayJoined: existing.relay_joined,
    };
  }

  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const inserted = await pool.query<{
    pubkey: string;
    encrypted_secret: string;
    relay_joined: boolean;
  }>(
    `INSERT INTO web_identity (user_id, pubkey, encrypted_secret)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING pubkey, encrypted_secret, relay_joined`,
    [userId, pubkey, encryptSecret(secret)],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("Unable to create web identity");
  return {
    pubkey: row.pubkey,
    encryptedSecret: row.encrypted_secret,
    relayJoined: row.relay_joined,
  };
}

export async function promoteIdentityUserId(
  legacyUserId: string,
  stableUserId: string,
): Promise<void> {
  if (legacyUserId === stableUserId) return;
  await ensureIdentityTable();
  try {
    await pool.query(
      `UPDATE web_identity AS legacy
       SET user_id = $2
       WHERE legacy.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM web_identity AS stable WHERE stable.user_id = $2
         )`,
      [legacyUserId, stableUserId],
    );
  } catch (error) {
    // Concurrent first requests can race to establish the permanent key. The
    // winning row is authoritative; the losing legacy row remains harmless.
    if ((error as { code?: string }).code !== "23505") throw error;
  }
}

export function signTemplate(
  identity: StoredIdentity,
  template: EventTemplate,
) {
  return finalizeEvent(
    {
      kind: template.kind,
      content: template.content,
      tags: template.tags,
      created_at: template.createdAt ?? Math.floor(Date.now() / 1000),
    },
    decryptSecret(identity.encryptedSecret),
  );
}

function nip98Authorization(
  identity: StoredIdentity,
  url: string,
  method: string,
  body: string,
): string {
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
    ["nonce", randomBytes(16).toString("hex")],
  ];
  if (body) {
    tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  }
  const event = signTemplate(identity, { kind: 27235, content: "", tags });
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

export async function relayPost<T>(
  identity: StoredIdentity,
  path: string,
  body: unknown,
): Promise<T> {
  const payload = JSON.stringify(body);
  const url = `${RELAY_HTTP_URL}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: nip98Authorization(identity, url, "POST", payload),
      "Content-Type": "application/json",
    },
    body: payload,
  });
  if (!response.ok) {
    throw new Error(
      (await response.text()) || `Relay returned ${response.status}`,
    );
  }
  return response.json() as Promise<T>;
}

export async function ensureRelayProfile(
  identity: StoredIdentity,
  displayName: string,
) {
  const profiles = await relayPost<unknown[]>(identity, "/query", [
    { kinds: [0], authors: [identity.pubkey], limit: 1 },
  ]);
  if (profiles.length > 0) return;

  const profile = signTemplate(identity, {
    kind: 0,
    content: JSON.stringify({
      display_name: displayName,
      name: displayName,
    }),
    tags: [],
  });
  await relayPost(identity, "/events", profile);
}

export async function ensureRelayMembership(
  userId: string,
  identity: StoredIdentity,
) {
  if (identity.relayJoined) return;

  const provisionerHex = process.env.BUZZ_PROVISIONER_PRIVATE_KEY;
  if (!provisionerHex)
    throw new Error("BUZZ_PROVISIONER_PRIVATE_KEY is required");
  const provisionerSecret = new Uint8Array(Buffer.from(provisionerHex, "hex"));
  const provisioner: StoredIdentity = {
    pubkey: getPublicKey(provisionerSecret),
    encryptedSecret: encryptSecret(provisionerSecret),
    relayJoined: true,
  };
  const invite = await relayPost<{ code: string }>(
    provisioner,
    "/api/invites",
    { ttl_secs: 600, max_uses: 1 },
  );
  await relayPost(identity, "/api/invites/claim", { code: invite.code });
  await pool.query(
    "UPDATE web_identity SET relay_joined = TRUE WHERE user_id = $1",
    [userId],
  );
}

export function validateEventTemplate(value: unknown): EventTemplate {
  if (!value || typeof value !== "object")
    throw new Error("Invalid event template");
  const input = value as Partial<EventTemplate>;
  if (!Number.isInteger(input.kind) || (input.kind as number) < 0) {
    throw new Error("Invalid event kind");
  }
  if (typeof input.content !== "string" || input.content.length > 1_000_000) {
    throw new Error("Invalid event content");
  }
  if (!Array.isArray(input.tags) || input.tags.length > 1000) {
    throw new Error("Invalid event tags");
  }
  const tags = input.tags.map((tag) => {
    if (!Array.isArray(tag) || tag.some((part) => typeof part !== "string")) {
      throw new Error("Invalid event tag");
    }
    return tag;
  });
  if (
    input.createdAt !== undefined &&
    (!Number.isInteger(input.createdAt) ||
      Math.abs(input.createdAt - Date.now() / 1000) > 600)
  ) {
    throw new Error("Invalid event timestamp");
  }
  return {
    kind: input.kind as number,
    content: input.content,
    tags,
    createdAt: input.createdAt,
  };
}
