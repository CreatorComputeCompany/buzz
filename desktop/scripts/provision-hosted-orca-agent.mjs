import { execFile } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

const exec = promisify(execFile);
const agentName = "Buzz Orca Agent";
const channelName = "agent-playground";
const relayHttpUrl = "https://imabird-buzz-relay.fly.dev";
const buzzCli = resolve("../target/release/buzz");
const computeAuthTag = resolve("../target/release/examples/compute_auth_tag");
const outputPath = process.env.BUZZ_ORCA_ENV_OUTPUT;
const respondToAllowlist = (process.env.BUZZ_ORCA_RESPOND_TO_ALLOWLIST ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const respondTo =
  process.env.BUZZ_ORCA_RESPOND_TO ??
  (respondToAllowlist.length > 0 ? "allowlist" : "owner-only");

if (!outputPath) throw new Error("BUZZ_ORCA_ENV_OUTPUT is required");
if (!new Set(["owner-only", "allowlist", "anyone"]).has(respondTo)) {
  throw new Error(
    "BUZZ_ORCA_RESPOND_TO must be owner-only, allowlist, or anyone",
  );
}
if (respondTo === "allowlist" && respondToAllowlist.length === 0) {
  throw new Error(
    "BUZZ_ORCA_RESPOND_TO_ALLOWLIST is required in allowlist mode",
  );
}
if (respondToAllowlist.some((pubkey) => !/^[0-9a-f]{64}$/.test(pubkey))) {
  throw new Error("BUZZ_ORCA_RESPOND_TO_ALLOWLIST contains an invalid pubkey");
}

function nip98Authorization(secret, url, method, body) {
  const event = finalizeEvent(
    {
      kind: 27235,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["u", url],
        ["method", method],
        ["nonce", randomBytes(16).toString("hex")],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ],
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function relayPost(secret, path, value, authTag = "") {
  const body = JSON.stringify(value);
  const url = `${relayHttpUrl}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: nip98Authorization(secret, url, "POST", body),
      "Content-Type": "application/json",
      ...(authTag ? { "x-auth-tag": authTag } : {}),
    },
    body,
  });
  if (!response.ok)
    throw new Error((await response.text()) || `${response.status}`);
  return response.json();
}

async function keychainSecret(service, create = false) {
  try {
    return (
      await exec("security", ["find-generic-password", "-w", "-s", service])
    ).stdout.trim();
  } catch (error) {
    if (!create) throw error;
    const secret = Buffer.from(generateSecretKey()).toString("hex");
    await exec("security", [
      "add-generic-password",
      "-U",
      "-a",
      "buzz",
      "-s",
      service,
      "-w",
      secret,
    ]);
    return secret;
  }
}

async function runBuzz(privateKey, args, authTag = "") {
  const { stdout } = await exec(buzzCli, args, {
    env: {
      ...process.env,
      BUZZ_AUTH_TAG: authTag,
      BUZZ_PRIVATE_KEY: privateKey,
      BUZZ_RELAY_URL: relayHttpUrl,
    },
  });
  return stdout.trim();
}

const ownerHex = await keychainSecret("imabird-buzz-relay-owner");
const agentHex = await keychainSecret("imabird-buzz-orca-agent", true);
if (!/^[0-9a-f]{64}$/i.test(ownerHex) || !/^[0-9a-f]{64}$/i.test(agentHex)) {
  throw new Error("Keychain contains an invalid Buzz private key");
}
const ownerSecret = new Uint8Array(Buffer.from(ownerHex, "hex"));
const agentSecret = new Uint8Array(Buffer.from(agentHex, "hex"));
const ownerPubkey = getPublicKey(ownerSecret);
const agentPubkey = getPublicKey(agentSecret);
const authTagJson = (
  await exec(computeAuthTag, [ownerHex, agentPubkey])
).stdout.trim();
const authTag = JSON.parse(authTagJson);

await runBuzz(
  agentHex,
  [
    "users",
    "set-profile",
    "--name",
    agentName,
    "--about",
    "Persistent coding agent whose work runs in isolated Orca worktrees",
  ],
  authTagJson,
);
await relayPost(
  agentSecret,
  "/events",
  finalizeEvent(
    {
      kind: 10100,
      content: JSON.stringify({
        channel_add_policy: "anyone",
        display_name: agentName,
        name: agentName,
        respond_to: respondTo,
        respond_to_allowlist: respondToAllowlist,
      }),
      created_at: Math.floor(Date.now() / 1000),
      tags: [authTag],
    },
    agentSecret,
  ),
  authTagJson,
);
await relayPost(
  ownerSecret,
  "/events",
  finalizeEvent(
    {
      kind: 30177,
      content: JSON.stringify({
        name: agentName,
        parallelism: 1,
        respond_to: respondTo,
        respond_to_allowlist: respondToAllowlist,
      }),
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", agentPubkey]],
    },
    ownerSecret,
  ),
);

const channels = JSON.parse(await runBuzz(ownerHex, ["channels", "list"]));
const channel = channels.find((candidate) => candidate.name === channelName);
if (!channel) throw new Error(`Channel not found: ${channelName}`);
const members = JSON.parse(
  await runBuzz(ownerHex, [
    "channels",
    "members",
    "--channel",
    channel.channel_id,
  ]),
);
if (
  !members.some(
    (member) => member.pubkey === agentPubkey && member.role === "bot",
  )
) {
  await runBuzz(ownerHex, [
    "channels",
    "add-member",
    "--channel",
    channel.channel_id,
    "--pubkey",
    agentPubkey,
    "--role",
    "bot",
  ]);
}

const environment = [
  `BUZZ_ACP_AGENT_OWNER=${ownerPubkey}`,
  `BUZZ_AUTH_TAG='${authTagJson}'`,
  `BUZZ_PRIVATE_KEY=${agentHex}`,
  `BUZZ_ACP_RESPOND_TO=${respondTo}`,
  `BUZZ_ACP_RESPOND_TO_ALLOWLIST=${respondToAllowlist.join(",")}`,
  "",
].join("\n");
await writeFile(outputPath, environment, { mode: 0o600 });
await chmod(outputPath, 0o600);
ownerSecret.fill(0);
agentSecret.fill(0);

console.log(
  JSON.stringify({
    agentName,
    agentPubkey,
    channelName,
    channelId: channel.channel_id,
    outputPath,
  }),
);
