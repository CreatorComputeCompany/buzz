import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const exec = promisify(execFile);
const baseUrl = process.env.BUZZ_WEB_URL ?? "https://buzz-web-alpha.vercel.app";
const password = process.env.BUZZ_WEB_TEST_PASSWORD ?? "test-password-48291";
const baselineAllowlist =
  process.env.BUZZ_ORCA_BASE_ALLOWLIST ??
  "feb8539a8444b4a47d8914336e4f530876016624b20b9246e7836d57a724b0bc";
const orcaHost = process.env.BUZZ_ORCA_HOST ?? "buzz-orca-host.boxd.sh";
const repositoryLabel = process.env.BUZZ_ORCA_TEST_REPOSITORY ?? "Buzz";
const model = process.env.BUZZ_ORCA_TEST_MODEL ?? "gpt-5.6-sol";
const runId = Date.now();
const firstReply = `CHAT-FIRST:${runId}`;
const followupReply = `CHAT-FOLLOWUP:${runId}`;
const terminalMarker = `BUZZ-ORCA-INTERACTIVE:${runId}`;
const terminalMarkerPath = `/tmp/buzz-orca-interactive-${runId}`;
const envOutput = `/tmp/buzz-orca-chat-proof-${runId}.env`;
const pairingFile = process.env.BUZZ_ORCA_PAIRING_FILE;
const skipTestAllowlist = process.env.BUZZ_ORCA_SKIP_TEST_ALLOWLIST === "true";
const testMobile = process.env.BUZZ_ORCA_TEST_MOBILE === "true";
const testAutoPairing = process.env.BUZZ_ORCA_TEST_AUTO_PAIRING === "true";
const baselineRuntimeUserIds =
  process.env.BUZZ_ORCA_ALLOWED_USER_IDS ?? "mvNHXRXkrigB9k1JQlk5JGIMuRmk8sig";

async function provisionAgent(allowlist) {
  await exec("node", ["scripts/provision-hosted-orca-agent.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BUZZ_ORCA_ENV_OUTPUT: envOutput,
      BUZZ_ORCA_RESPOND_TO_ALLOWLIST: allowlist,
    },
  });
  await unlink(envOutput).catch(() => {});
}

async function configureRuntimeAllowlist(allowlist) {
  const serviceConfig = [
    "[Service]",
    "Environment=BUZZ_ORCA_ALLOWED_CONVERSATIONS=",
    "Environment=BUZZ_ORCA_ALLOWED_PROVIDERS=codex",
    "Environment=BUZZ_ORCA_ALLOWED_REPO_SELECTORS=id:123b4e80-ef97-428b-b9d6-0bcc456f82ee,id:a33a20c0-e67f-4f9a-85ec-be1859ba6116,id:57fca5b3-1644-4a26-9327-06f6ac439a2e,id:357a7191-0573-4f4b-a60d-f9eaac636790,id:ecdfe907-dabd-495b-857a-38b833d0e033",
    "",
  ].join("\n");
  const encodedConfig = Buffer.from(serviceConfig).toString("base64");
  await exec("ssh", [
    orcaHost,
    `sudo -n sed -i -e 's/^BUZZ_ACP_RESPOND_TO_ALLOWLIST=.*/BUZZ_ACP_RESPOND_TO_ALLOWLIST=${allowlist}/' -e 's/^BUZZ_ORCA_ALLOWED_CONVERSATIONS=.*/BUZZ_ORCA_ALLOWED_CONVERSATIONS=/' /etc/buzz-orca-agent.env && printf %s ${encodedConfig} | base64 -d | sudo -n tee /etc/systemd/system/buzz-orca-agent.service.d/chats.conf >/dev/null && sudo -n systemctl daemon-reload && sudo -n systemctl restart buzz-orca-agent.service && sleep 3 && systemctl is-active --quiet buzz-orca-agent.service`,
  ]);
}

async function configureWebRuntimeUsers(userIds) {
  await exec("fly", [
    "secrets",
    "set",
    "-a",
    "imabird-buzz-web-api",
    `BUZZ_ORCA_ALLOWED_USER_IDS=${userIds}`,
  ]);
}

async function sendMessage(page, text) {
  const composer = page.getByTestId("message-composer");
  const input = composer.locator('[contenteditable="true"]');
  await input.click();
  await input.pressSequentially(text);
  await composer.getByTestId("send-message").click();
}

async function waitForAgentReply(page, expected) {
  const row = page.getByTestId("message-row").filter({ hasText: expected });
  const reply = row.getByText(expected, { exact: true });
  await reply.waitFor({ timeout: 240_000 });
  await reply
    .locator("xpath=preceding::*[@data-testid='message-author'][1]")
    .getByText("Buzz Orca Agent", { exact: true })
    .waitFor({ timeout: 30_000 });
}

async function remoteTerminalMarkerPresent(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await exec("ssh", [
        orcaHost,
        `cat ${terminalMarkerPath}`,
      ]);
      if (stdout.trim() === terminalMarker) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const browser = await chromium.launch({ headless: true });
let page;
let allowlistExtended = false;
let runtimeUsersExtended = false;
try {
  page = await browser.newPage(
    testMobile ? { viewport: { width: 390, height: 844 } } : undefined,
  );
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(`Orca Chat User ${runId}`);
  await page.getByLabel("Email").fill(`orca-chat-${runId}@imabird.local`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("app-sidebar-layer").waitFor({ timeout: 30_000 });
  if (testMobile) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page.getByText("Chats", { exact: true }).waitFor({ timeout: 30_000 });
  } else {
    await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
  }
  if (pairingFile) {
    const pairingUrl = (await readFile(pairingFile, "utf8")).trim();
    const code = new URL(pairingUrl).searchParams.get("code");
    if (!code) throw new Error("Orca pairing file is invalid");
    const offer = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
    await page.evaluate((pairing) => {
      window.localStorage.setItem(
        "buzz.orca.runtime-pairing.v1",
        JSON.stringify(pairing),
      );
    }, offer);
  }

  const identity = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error("Tauri browser adapter is unavailable");
    return invoke("get_identity");
  });
  if (!identity?.pubkey) throw new Error("Web account identity is unavailable");
  if (testAutoPairing) {
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/get-session", {
        credentials: "include",
      });
      return response.json();
    });
    if (!session?.user?.id)
      throw new Error("Web account session is unavailable");
    await configureWebRuntimeUsers(
      `${baselineRuntimeUserIds},${session.user.id}`,
    );
    runtimeUsersExtended = true;
  }
  if (!skipTestAllowlist) {
    const testAllowlist = `${baselineAllowlist},${identity.pubkey}`;
    await provisionAgent(testAllowlist);
    await configureRuntimeAllowlist(testAllowlist);
    allowlistExtended = true;
  }

  await page.getByTestId("section-actions-chats-quick-create").click();
  await page
    .getByRole("dialog")
    .getByText("New chat", { exact: true })
    .waitFor();
  await page
    .getByTestId("new-chat-repository")
    .selectOption({ label: repositoryLabel });
  await page.getByTestId("new-chat-provider").selectOption("codex");
  await page.getByTestId("new-chat-model").fill(model);
  await page.getByTestId("new-chat-create").click();
  const chatLabel = model ? `${repositoryLabel} · ${model}` : repositoryLabel;
  await page.getByTestId("chat-list").getByText(chatLabel).waitFor({
    timeout: 30_000,
  });
  if (testMobile) {
    const mobileSidebar = page.locator('[role="dialog"][data-mobile="true"]');
    await mobileSidebar
      .locator(":scope > button")
      .evaluate((button) => button.click());
    await mobileSidebar.waitFor({ state: "hidden", timeout: 30_000 });
  }

  await new Promise((resolve) => setTimeout(resolve, 10_000));
  await sendMessage(page, `Reply with exactly ${firstReply} and nothing else.`);
  await waitForAgentReply(page, firstReply);
  await sendMessage(
    page,
    `Continue in the same worktree and reply with exactly ${followupReply} and nothing else.`,
  );
  await waitForAgentReply(page, followupReply);

  if (pairingFile || testAutoPairing) {
    await page.getByTestId("orca-chat-session-view").click();
    await page.getByTestId("orca-session-view").waitFor();
    // Orca Web's real renderer mounts in the light DOM. A shadow root on the
    // embed container means the forbidden embedding approach came back.
    const embed = page.locator("[data-orca-web-embed]");
    await embed.waitFor({ timeout: 60_000 });
    const usesShadowDom = await embed.evaluate(
      (element) => element.shadowRoot !== null,
    );
    if (usesShadowDom) {
      throw new Error("Orca embed must mount in the light DOM, not Shadow DOM");
    }

    // A fresh browser first sees Orca's own member-identity setup.
    const identityName = embed.locator("#multiplayer-name");
    const workspaceTab = embed.locator('[data-testid="sortable-tab"]').first();
    await Promise.race([
      identityName.waitFor({ state: "visible", timeout: 120_000 }),
      workspaceTab.waitFor({ state: "visible", timeout: 120_000 }),
    ]);
    if (await identityName.isVisible()) {
      await identityName.fill(`Orca Chat User ${runId}`);
      await embed
        .locator("#multiplayer-email")
        .fill(`orca-chat-${runId}@imabird.local`);
      await embed.locator("#multiplayer-password").fill(password);
      await embed.locator("#multiplayer-password-confirm").fill(password);
      await embed.getByRole("button", { name: "Create account" }).click();
    }

    await workspaceTab.waitFor({ state: "visible", timeout: 120_000 });
    await embed
      .locator(".xterm-screen")
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });

    const tabsBefore = await embed
      .locator('[data-testid="sortable-tab"]')
      .count();
    await embed.getByRole("button", { name: "New tab" }).click({ force: true });
    const newTerminalMenuItem = page
      .getByRole("menuitem", { name: /New Terminal/i })
      .first();
    await newTerminalMenuItem.waitFor({ state: "visible", timeout: 10_000 });
    await newTerminalMenuItem.click({ force: true });
    await page.waitForFunction(
      (expectedTabs) =>
        document.querySelectorAll(
          '[data-orca-web-embed] [data-testid="sortable-tab"]',
        ).length > expectedTabs,
      tabsBefore,
      { timeout: 10_000 },
    );

    // Real keyboard input: focus the terminal and type. No synthetic bridge
    // events — this proves keystrokes reach the remote PTY. The shell in the
    // new tab may still be spawning, so retry the whole line once.
    let markerSeen = false;
    for (let attempt = 0; attempt < 3 && !markerSeen; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const terminalInput = embed
        .locator(".xterm-helper-textarea:visible")
        .last();
      await terminalInput.click({ force: true });
      await page.waitForFunction(() =>
        document.activeElement?.classList.contains("xterm-helper-textarea"),
      );
      await page.keyboard.press("Control+C");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await terminalInput.pressSequentially(
        `printf '${terminalMarker}\\n' | tee ${terminalMarkerPath}`,
        { delay: 25 },
      );
      await page.keyboard.press("Enter");
      markerSeen = await remoteTerminalMarkerPresent(20_000);
    }
    if (!markerSeen) {
      throw new Error("Native Orca terminal did not execute typed input");
    }
    await page.screenshot({
      path: "/tmp/buzz-web-orca-native-session-proof.png",
      fullPage: true,
    });
  }

  await page.screenshot({
    path: "/tmp/buzz-web-orca-chat-proof.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      firstReply,
      followupReply,
      model: model || null,
      provider: "codex",
      repository: repositoryLabel,
      mobile: testMobile,
      memberAuthorized: skipTestAllowlist,
      autoPairing: testAutoPairing,
      sessionView: pairingFile || testAutoPairing ? "passed" : "skipped",
      nativeSession: pairingFile || testAutoPairing ? "passed" : "skipped",
      interactiveSession: pairingFile || testAutoPairing ? "passed" : "skipped",
      result: "passed",
    }),
  );
} catch (error) {
  if (page) {
    await page.screenshot({
      path: "/tmp/buzz-web-orca-chat-failure.png",
      fullPage: true,
    });
    console.error((await page.locator("body").innerText()).slice(-4_000));
  }
  throw error;
} finally {
  await browser.close();
  if (allowlistExtended) {
    await provisionAgent(baselineAllowlist);
    await configureRuntimeAllowlist(baselineAllowlist);
  }
  if (runtimeUsersExtended) {
    await configureWebRuntimeUsers(baselineRuntimeUserIds);
  }
  await unlink(envOutput).catch(() => {});
  await exec("ssh", [orcaHost, `rm -f ${terminalMarkerPath}`]).catch(() => {});
}
