import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.BUZZ_WEB_URL ?? "https://buzz-web-alpha.vercel.app";
const password = process.env.BUZZ_WEB_TEST_PASSWORD ?? "test-password-48291";
const runId = Date.now();
const aliceName = `Alice Web ${runId}`;
const bobName = `Bob Web ${runId}`;
const channelName = `web-proof-${runId}`;
const aliceMessage = `Hello from Alice ${runId}`;
const bobMessage = `Hello from Bob ${runId}`;
const threadRoot = `Thread root from Alice ${runId}`;
const bobThreadReply = `Thread reply from Bob ${runId}`;
const aliceThreadReply = `Thread reply from Alice ${runId}`;
const aliceDm = `Private hello from Alice ${runId}`;
const bobDm = `Private hello from Bob ${runId}`;
const attachmentName = `web-proof-${runId}.pdf`;
const reconnectMessage = `Delivered after reconnect ${runId}`;
const keyboardMessage = `Sent with Enter ${runId}`;
const mobileMessage = `Sent from mobile viewport ${runId}`;
const attachmentBytes = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
const sendAttempts = 3;
const sendAttemptTimeoutMs = 15_000;
const sendRetryDelayMs = 6_000;

const browser = await chromium.launch({ headless: true });
const aliceContext = await browser.newContext();
const bobContext = await browser.newContext();
const alice = await aliceContext.newPage();
const bob = await bobContext.newPage();
const diagnostics = [];
for (const [name, page] of [
  ["Alice", alice],
  ["Bob", bob],
]) {
  page.on("pageerror", (error) => diagnostics.push(`${name}: ${error.stack}`));
  page.on("console", (message) => {
    if (message.type() === "error")
      diagnostics.push(`${name}: ${message.text()}`);
  });
}

async function signUp(page, name) {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(name);
  await page
    .getByLabel("Email")
    .fill(`${name.toLowerCase().replaceAll(" ", "-")}-${runId}@imabird.local`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText(name, { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
}

async function createChannel(page) {
  await page.getByTestId("section-actions-channels-quick-create").click();
  await page.getByTestId("channel-browser-search").fill(channelName);
  await page.getByTestId("channel-browser-create-row").click();
  await page.getByTestId("create-channel-submit").click();
  await page.getByTestId(`channel-${channelName}`).waitFor({ timeout: 30_000 });
}

async function joinChannel(page) {
  await page.getByTestId("section-actions-channels-quick-create").click();
  await page.getByTestId("channel-browser-search").fill(channelName);
  const channelRow = page.getByTestId(`browse-channel-${channelName}`);
  await channelRow.waitFor({ timeout: 30_000 });
  await channelRow.getByRole("button", { name: "Join" }).click();
  await page.getByTestId(`channel-${channelName}`).waitFor({ timeout: 30_000 });
}

async function sendFromComposer(composer, resultSurface, message) {
  const input = composer.locator('[contenteditable="true"]');
  const sendButton = composer.getByTestId("send-message");
  const deliveredMessage = resultSurface
    .getByTestId("message-row")
    .filter({ hasText: message })
    .getByText(message, { exact: true });
  for (let attempt = 1; attempt <= sendAttempts; attempt += 1) {
    await input.fill(message);
    for (let waitAttempt = 0; waitAttempt < 50; waitAttempt += 1) {
      if (await sendButton.isEnabled()) break;
      await composer.page().waitForTimeout(100);
    }
    if (!(await sendButton.isEnabled())) {
      throw new Error("Composer never enabled after message input.");
    }
    await sendButton.click();
    try {
      await deliveredMessage.waitFor({ timeout: sendAttemptTimeoutMs });
      return;
    } catch (error) {
      if (attempt === sendAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, sendRetryDelayMs));
      if (await deliveredMessage.isVisible().catch(() => false)) return;
    }
  }
}

async function sendMessage(page, message) {
  await sendFromComposer(page.getByTestId("message-composer"), page, message);
}

async function sendMessageWithEnter(page, observer, message) {
  const composer = page.getByTestId("message-composer");
  const input = composer.locator('[contenteditable="true"]');
  await input.fill(message);
  const sendButton = composer.getByTestId("send-message");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await sendButton.isEnabled()) break;
    await page.waitForTimeout(100);
  }
  if (!(await sendButton.isEnabled())) {
    throw new Error("Composer never enabled after keyboard input.");
  }
  await input.press("Enter");
  await observer
    .getByTestId("message-timeline")
    .getByText(message, { exact: true })
    .waitFor({ timeout: 30_000 });
}

function messageRow(page, message) {
  return page
    .getByTestId("message-timeline")
    .getByTestId("message-row")
    .filter({ hasText: message });
}

function thumbsUpReaction(messageRow) {
  return messageRow.getByRole("button", { name: "Toggle 👍 reaction" });
}

async function waitForReactionCount(messageRow, count) {
  await thumbsUpReaction(messageRow)
    .locator(".sr-only")
    .getByText(String(count), { exact: true })
    .waitFor({ timeout: 30_000 });
}

async function addThumbsUpReaction(messageRow) {
  await messageRow.hover();
  await messageRow.getByRole("button", { name: "React with :+1:" }).click();
}

async function removeThumbsUpReaction(messageRow, observedRows) {
  for (let attempt = 1; attempt <= sendAttempts; attempt += 1) {
    const reaction = thumbsUpReaction(messageRow);
    if ((await reaction.getAttribute("aria-pressed")) === "true") {
      await reaction.click();
    }
    try {
      await Promise.all(
        observedRows.map((row) => waitForReactionCount(row, 1)),
      );
      return;
    } catch (error) {
      if (attempt === sendAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, sendRetryDelayMs));
    }
  }
}

async function openThreadForMessage(page, message) {
  const rootMessageRow = messageRow(page, message);
  await rootMessageRow.waitFor({ timeout: 30_000 });
  await rootMessageRow.hover();
  await rootMessageRow
    .locator('[data-testid^="reply-message-"]')
    .click({ force: true });
  const threadPanel = page.getByTestId("message-thread-panel");
  await threadPanel.waitFor({ timeout: 30_000 });
  return threadPanel;
}

async function sendThreadReply(threadPanel, message) {
  await sendFromComposer(
    threadPanel.getByTestId("message-composer"),
    threadPanel,
    message,
  );
}

async function startDirectMessage(page, recipientName, message) {
  await page.getByTestId("section-actions-dms").click();
  await page.getByRole("menuitem", { name: "New message" }).click();
  await page.getByTestId("new-message-page").waitFor();
  await page.getByTestId("new-dm-search").fill(recipientName);
  const recipient = page
    .locator('[data-testid^="new-dm-result-"]')
    .filter({ hasText: recipientName });
  await recipient.waitFor({ timeout: 30_000 });
  await recipient.click();
  await sendMessage(page, message);
}

async function openDirectMessage(page, participantName) {
  const directMessages = page.getByTestId("dm-list");
  await directMessages
    .getByText(participantName, { exact: true })
    .waitFor({ timeout: 30_000 });
  await directMessages.getByText(participantName, { exact: true }).click();
}

async function waitForChatPresence(page, status, timeout = 30_000) {
  await page
    .getByTestId("chat-presence-badge")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("chat-presence-badge")
    .getByText(status, { exact: true })
    .waitFor({ timeout });
}

async function setPresence(page, status) {
  if (!(await page.getByTestId("profile-popover").isVisible())) {
    await page.getByTestId("sidebar-profile-avatar-button").click();
  }
  await page.getByTestId("profile-popover-presence-trigger").click();
  await page.getByTestId(`profile-popover-status-${status}`).click();
}

async function transitionPresence(actor, observer, status, label) {
  for (let attempt = 1; attempt <= sendAttempts; attempt += 1) {
    await setPresence(actor, status);
    await new Promise((resolve) => setTimeout(resolve, sendRetryDelayMs));
    try {
      await waitForChatPresence(observer, label, sendAttemptTimeoutMs);
      return;
    } catch (error) {
      if (attempt === sendAttempts) throw error;
    }
  }
}

async function uploadAttachment(page) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Attach file" }).click(),
  ]);
  await chooser.setFiles({
    buffer: attachmentBytes,
    mimeType: "application/pdf",
    name: attachmentName,
  });
  const composer = page.getByTestId("message-composer");
  await composer.getByText(attachmentName, { exact: true }).waitFor({
    timeout: 30_000,
  });
  await composer.getByTestId("send-message").click();
  await page
    .getByTestId("file-card")
    .filter({ hasText: attachmentName })
    .waitFor({ timeout: 30_000 });
}

try {
  await signUp(alice, aliceName);
  await signUp(bob, bobName);
  await createChannel(alice);
  await joinChannel(bob);

  await sendMessage(alice, aliceMessage);
  await bob
    .getByText(aliceMessage, { exact: true })
    .waitFor({ timeout: 30_000 });

  await sendMessage(bob, bobMessage);
  await Promise.all(
    [alice, bob].map((page) =>
      page.getByText(bobMessage, { exact: true }).waitFor({ timeout: 30_000 }),
    ),
  );

  const aliceBobMessage = messageRow(alice, bobMessage);
  const bobOwnMessage = messageRow(bob, bobMessage);
  await addThumbsUpReaction(aliceBobMessage);
  await Promise.all([
    waitForReactionCount(aliceBobMessage, 1),
    waitForReactionCount(bobOwnMessage, 1),
  ]);
  await thumbsUpReaction(bobOwnMessage).click();
  await Promise.all([
    waitForReactionCount(aliceBobMessage, 2),
    waitForReactionCount(bobOwnMessage, 2),
  ]);
  await removeThumbsUpReaction(aliceBobMessage, [
    aliceBobMessage,
    bobOwnMessage,
  ]);

  await alice.screenshot({
    path: "/tmp/buzz-web-two-user-proof.png",
    fullPage: true,
  });

  await sendMessage(alice, threadRoot);
  await bob.getByText(threadRoot, { exact: true }).waitFor({ timeout: 30_000 });
  const bobThread = await openThreadForMessage(bob, threadRoot);
  await sendThreadReply(bobThread, bobThreadReply);
  const aliceThread = await openThreadForMessage(alice, threadRoot);
  await aliceThread
    .getByText(bobThreadReply, { exact: true })
    .waitFor({ timeout: 30_000 });
  await sendThreadReply(aliceThread, aliceThreadReply);
  await bobThread
    .getByText(aliceThreadReply, { exact: true })
    .waitFor({ timeout: 30_000 });

  await Promise.all([alice.reload(), bob.reload()]);
  for (const page of [alice, bob]) {
    const threadPanel = page.getByTestId("message-thread-panel");
    await threadPanel.waitFor({ timeout: 30_000 });
    await threadPanel
      .getByText(bobThreadReply, { exact: true })
      .waitFor({ timeout: 30_000 });
    await threadPanel
      .getByText(aliceThreadReply, { exact: true })
      .waitFor({ timeout: 30_000 });
  }
  await Promise.all([
    waitForReactionCount(messageRow(alice, bobMessage), 1),
    waitForReactionCount(messageRow(bob, bobMessage), 1),
  ]);

  await alice.screenshot({
    path: "/tmp/buzz-web-two-user-thread-proof.png",
    fullPage: true,
  });

  await startDirectMessage(alice, bobName, aliceDm);
  await openDirectMessage(bob, aliceName);
  await bob.getByText(aliceDm, { exact: true }).waitFor({ timeout: 30_000 });
  await sendMessage(bob, bobDm);
  await Promise.all(
    [alice, bob].map((page) =>
      page.getByText(bobDm, { exact: true }).waitFor({ timeout: 30_000 }),
    ),
  );

  await transitionPresence(alice, bob, "online", "Online");
  await transitionPresence(bob, alice, "online", "Online");
  await transitionPresence(bob, alice, "offline", "Offline");
  await transitionPresence(bob, alice, "online", "Online");

  await alice.screenshot({
    path: "/tmp/buzz-web-two-user-dm-proof.png",
    fullPage: true,
  });

  await Promise.all(
    [alice, bob].map(async (page) => {
      await page.getByTestId(`channel-${channelName}`).click();
      await page.getByTestId("message-timeline").waitFor();
    }),
  );
  await uploadAttachment(alice);
  await bob
    .getByTestId("file-card")
    .filter({ hasText: attachmentName })
    .waitFor({ timeout: 30_000 });
  await Promise.all([alice.reload(), bob.reload()]);
  await Promise.all(
    [alice, bob].map((page) =>
      page
        .getByTestId("file-card")
        .filter({ hasText: attachmentName })
        .waitFor({ timeout: 30_000 }),
    ),
  );
  const bobFileCard = bob
    .getByTestId("file-card")
    .filter({ hasText: attachmentName });
  const [download] = await Promise.all([
    bob.waitForEvent("download"),
    bobFileCard.click(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Attachment download has no local path.");
  const downloadedBytes = await readFile(downloadPath);
  if (!downloadedBytes.equals(attachmentBytes)) {
    throw new Error("Downloaded attachment bytes did not match the upload.");
  }

  await alice.screenshot({
    path: "/tmp/buzz-web-attachment-proof.png",
    fullPage: true,
  });

  await bobContext.setOffline(true);
  await bob.waitForTimeout(1_000);
  await sendMessage(alice, reconnectMessage);
  if (await bob.getByText(reconnectMessage, { exact: true }).isVisible()) {
    throw new Error("Offline browser received a live message.");
  }
  await bobContext.setOffline(false);
  await bob.evaluate(() => window.dispatchEvent(new Event("online")));
  await bob.bringToFront();
  await bob
    .getByText(reconnectMessage, { exact: true })
    .waitFor({ timeout: 60_000 });
  await bob.waitForTimeout(2_000);
  const reconnectCopies = await messageRow(bob, reconnectMessage).count();
  if (reconnectCopies !== 1) {
    throw new Error(
      `Expected one reconnected message, found ${reconnectCopies}.`,
    );
  }
  await sendMessageWithEnter(alice, bob, keyboardMessage);

  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.reload();
  await alice.getByTestId("message-timeline").waitFor({ timeout: 30_000 });
  await alice.getByTestId("message-composer").waitFor({ timeout: 30_000 });
  await sendMessage(alice, mobileMessage);
  await bob
    .getByText(mobileMessage, { exact: true })
    .waitFor({ timeout: 30_000 });
  await alice.screenshot({
    path: "/tmp/buzz-web-mobile-proof.png",
    fullPage: false,
  });
  console.log(
    JSON.stringify({
      baseUrl,
      channelName,
      channelMessages: [aliceMessage, bobMessage],
      thread: {
        replies: [bobThreadReply, aliceThreadReply],
        root: threadRoot,
      },
      directMessages: [aliceDm, bobDm],
      attachment: {
        downloadedBytesMatch: true,
        filename: attachmentName,
        persisted: true,
      },
      keyboard: { message: keyboardMessage, sentWithEnter: true },
      presence: { transitions: ["online", "offline", "online"] },
      reactions: { emoji: "👍", persistedCount: 1 },
      reconnection: { deliveredOnce: true, message: reconnectMessage },
      responsive: { message: mobileMessage, viewport: "390x844" },
      result: "passed",
    }),
  );
} catch (error) {
  for (const page of [alice, bob]) {
    const showError = page.getByRole("button", { name: "Show Error" });
    if (await showError.isVisible().catch(() => false)) await showError.click();
  }
  console.error(
    "Alice page:",
    (
      await alice
        .locator("body")
        .innerText()
        .catch(() => "(page closed)")
    ).slice(-2_000),
  );
  console.error(
    "Bob page:",
    (
      await bob
        .locator("body")
        .innerText()
        .catch(() => "(page closed)")
    ).slice(-2_000),
  );
  console.error("Browser diagnostics:", diagnostics.join("\n"));
  throw error;
} finally {
  await browser.close();
}
