import { chromium } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

const exec = promisify(execFile);
const baseUrl = process.env.BUZZ_WEB_URL ?? "https://buzz-web-alpha.vercel.app";
const relayHttpUrl = "https://imabird-buzz-relay.fly.dev";
const relayWsUrl = "wss://imabird-buzz-relay.fly.dev";
const password = process.env.BUZZ_WEB_TEST_PASSWORD ?? "test-password-48291";
const runId = Date.now();
const userName = `Agent Proof User ${runId}`;
const agentName = `Hosted Proof Agent ${runId}`;
const channelName = `agent-proof-${runId}`;
const mentionId = `hosted-${runId}`;
const expectedReply = `AE-ACK:${mentionId}`;
const buzzCli = resolve("../target/release/buzz");
const buzzAcp = resolve("../target/release/buzz-acp");
const computeAuthTag = resolve("../target/release/examples/compute_auth_tag");
const fakeAgent = resolve("tests/e2e/fixtures/fake-acp-agent.mjs");

function nip98Authorization(secret, url, method, body) {
  const tags = [
    ["u", url],
    ["method", method],
    ["nonce", randomBytes(16).toString("hex")],
  ];
  if (body) {
    tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  }
  const event = finalizeEvent(
    {
      kind: 27235,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags,
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function relayPost(secret, path, value, authTag = "") {
  const body = JSON.stringify(value);
  const url = `${relayHttpUrl}${path}`;
  const headers = {
    Authorization: nip98Authorization(secret, url, "POST", body),
    "Content-Type": "application/json",
  };
  if (authTag) headers["x-auth-tag"] = authTag;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(
      (await response.text()) || `Relay returned ${response.status}`,
    );
  }
  return response.json();
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

function waitForLog(readLog, pattern, timeoutMs = 30_000) {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (pattern.test(readLog())) return resolveWait();
      if (Date.now() >= deadline) {
        return reject(new Error(`Timed out waiting for ACP log ${pattern}.`));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("ACP harness did not stop.")), 10_000),
    ),
  ]);
}

const ownerHex = (
  await exec("security", [
    "find-generic-password",
    "-w",
    "-s",
    "imabird-buzz-relay-owner",
  ])
).stdout.trim();
if (!/^[0-9a-f]{64}$/i.test(ownerHex)) {
  throw new Error("Relay owner key is unavailable from the macOS Keychain.");
}
const ownerSecret = new Uint8Array(Buffer.from(ownerHex, "hex"));
const agentSecret = generateSecretKey();
const agentHex = Buffer.from(agentSecret).toString("hex");
const agentPubkey = getPublicKey(agentSecret);
const ownerPubkey = getPublicKey(ownerSecret);

let harness;
let browser;
let harnessLog = "";
try {
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
      "Deterministic hosted ACP acceptance agent",
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
          channel_add_policy: "owner_only",
          display_name: agentName,
          name: agentName,
          respond_to: "anyone",
          respond_to_allowlist: [],
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
          respond_to: "anyone",
          respond_to_allowlist: [],
        }),
        created_at: Math.floor(Date.now() / 1000),
        tags: [["d", agentPubkey]],
      },
      ownerSecret,
    ),
  );
  const channel = JSON.parse(
    await runBuzz(ownerHex, [
      "channels",
      "create",
      "--name",
      channelName,
      "--type",
      "stream",
      "--visibility",
      "open",
      "--description",
      "Hosted browser-to-agent acceptance proof",
    ]),
  );
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

  harness = spawn(buzzAcp, [], {
    cwd: resolve(".."),
    env: {
      ...process.env,
      BUZZ_ACP_AGENT_ARGS: fakeAgent,
      BUZZ_ACP_AGENT_COMMAND: process.execPath,
      BUZZ_ACP_NO_MEMORY: "true",
      BUZZ_ACP_RESPOND_TO: "anyone",
      BUZZ_ACP_AGENT_OWNER: ownerPubkey,
      BUZZ_AUTH_TAG: authTagJson,
      BUZZ_E2E_CLI_BIN: buzzCli,
      BUZZ_PRIVATE_KEY: agentHex,
      BUZZ_RELAY_URL: relayWsUrl,
      RUST_LOG: "buzz_acp=info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appendLog = (chunk) => {
    harnessLog += chunk.toString();
  };
  harness.stdout.on("data", appendLog);
  harness.stderr.on("data", appendLog);
  await waitForLog(() => harnessLog, /agent initialized/i, 60_000);
  await waitForLog(() => harnessLog, new RegExp(channel.channel_id), 60_000);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(userName);
  await page.getByLabel("Email").fill(`agent-proof-${runId}@imabird.local`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
  await page.getByTestId("section-actions-channels-quick-create").click();
  await page.getByTestId("channel-browser-search").fill(channelName);
  const channelRow = page.getByTestId(`browse-channel-${channelName}`);
  await channelRow.waitFor({ timeout: 30_000 });
  await channelRow.getByRole("button", { name: "Join" }).click();
  await page.getByTestId(`channel-${channelName}`).waitFor({ timeout: 30_000 });

  const adapterState = await page.evaluate(async (channelId) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return { error: "Tauri browser adapter is unavailable" };
    const [agents, members] = await Promise.all([
      invoke("list_relay_agents"),
      invoke("get_channel_members", { channelId }),
    ]);
    return { agents, members };
  }, channel.channel_id);
  const discoveredAgents = Array.isArray(adapterState.agents)
    ? adapterState.agents
    : [];
  if (!discoveredAgents.some((agent) => agent.pubkey === agentPubkey)) {
    throw new Error(
      `Browser adapter did not discover hosted agent: ${JSON.stringify(adapterState)}`,
    );
  }

  const composer = page.getByTestId("message-composer");
  const input = composer.locator('[contenteditable="true"]');
  await input.click();
  await input.pressSequentially("@Hosted");
  const suggestion = page
    .getByTestId("mention-autocomplete")
    .getByText(agentName, { exact: true });
  await suggestion.waitFor({ timeout: 30_000 });
  await suggestion.click();
  await input.press("End");
  await input.pressSequentially(` AE-ID:${mentionId}`);
  await composer.getByTestId("send-message").click();

  const rootRow = page
    .getByTestId("message-row")
    .filter({ hasText: `AE-ID:${mentionId}` });
  await rootRow.waitFor({ timeout: 30_000 });
  await rootRow.hover();
  await rootRow.getByRole("button", { name: "Reply" }).click();
  const threadPanel = page.getByTestId("message-thread-panel");
  await threadPanel.waitFor({ timeout: 30_000 });
  const replyRow = threadPanel
    .getByTestId("message-row")
    .filter({ hasText: expectedReply });
  await replyRow.getByText(expectedReply, { exact: true }).waitFor({
    timeout: 90_000,
  });
  await replyRow.getByText(agentName, { exact: true }).waitFor({
    timeout: 30_000,
  });
  await page.screenshot({
    path: "/tmp/buzz-web-agent-proof.png",
    fullPage: true,
  });

  console.log(
    JSON.stringify({
      agentName,
      agentPubkey,
      channelId: channel.channel_id,
      channelName,
      mentionId,
      reply: expectedReply,
      result: "passed",
    }),
  );
} catch (error) {
  if (harnessLog) console.error(harnessLog.slice(-6_000));
  throw error;
} finally {
  if (browser) await browser.close();
  if (harness) await stopProcess(harness);
  agentSecret.fill(0);
  ownerSecret.fill(0);
}
