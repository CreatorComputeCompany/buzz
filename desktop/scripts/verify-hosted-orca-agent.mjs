import { chromium } from "@playwright/test";

const baseUrl = process.env.BUZZ_WEB_URL ?? "https://buzz-web-alpha.vercel.app";
const password = process.env.BUZZ_WEB_TEST_PASSWORD ?? "test-password-48291";
const runId = Date.now();
const agentName = "Buzz Orca Agent";
const channelName = "agent-playground";
const firstReply = `ORCA-FIRST:${runId}`;
const followupReply = `ORCA-FOLLOWUP:${runId}`;

async function mentionAgent(composer, instruction) {
  const input = composer.locator('[contenteditable="true"]');
  await input.click();
  await input.pressSequentially("@Buzz");
  const suggestion = composer
    .page()
    .getByTestId("mention-autocomplete")
    .getByText(agentName, { exact: true });
  await suggestion.waitFor({ timeout: 30_000 });
  await suggestion.click();
  await input.press("End");
  await input.pressSequentially(` ${instruction}`);
  await composer.getByTestId("send-message").click();
}

async function waitForAgentReply(scope, expected) {
  const row = scope.getByTestId("message-row").filter({ hasText: expected });
  await row.getByText(expected, { exact: true }).waitFor({ timeout: 180_000 });
  await row
    .getByTestId("message-author")
    .getByText(agentName, { exact: true })
    .waitFor({ timeout: 30_000 });
}

const browser = await chromium.launch({ headless: true });
let page;
try {
  page = await browser.newPage();
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Name").fill(`Orca Agent User ${runId}`);
  await page.getByLabel("Email").fill(`orca-agent-${runId}@imabird.local`);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByTestId("app-sidebar").waitFor({ timeout: 30_000 });
  await page.getByTestId("section-actions-channels-quick-create").click();
  await page.getByTestId("channel-browser-search").fill(channelName);
  const channelRow = page.getByTestId(`browse-channel-${channelName}`);
  await channelRow.waitFor({ timeout: 30_000 });
  await channelRow.getByRole("button", { name: "Join", exact: true }).click();
  await page.getByTestId(`channel-${channelName}`).waitFor({ timeout: 30_000 });

  const adapterState = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return { error: "Tauri browser adapter is unavailable" };
    return { agents: await invoke("list_relay_agents") };
  });
  if (
    !Array.isArray(adapterState.agents) ||
    !adapterState.agents.some((agent) => agent.name === agentName)
  ) {
    throw new Error(
      `Browser adapter did not discover Orca agent: ${JSON.stringify(adapterState)}`,
    );
  }

  const channelComposer = page.getByTestId("message-composer");
  await mentionAgent(
    channelComposer,
    `Reply in this thread with exactly ${firstReply} and nothing else.`,
  );
  const rootRow = page
    .getByTestId("message-row")
    .filter({ hasText: firstReply });
  await rootRow.waitFor({ timeout: 30_000 });
  await rootRow.hover();
  await rootRow.getByRole("button", { name: "Reply" }).click();
  const threadPanel = page.getByTestId("message-thread-panel");
  await threadPanel.waitFor({ timeout: 30_000 });
  await waitForAgentReply(threadPanel, firstReply);

  const threadComposer = threadPanel.getByTestId("message-composer");
  await mentionAgent(
    threadComposer,
    `Continue in the same session. Reply with exactly ${followupReply} and nothing else.`,
  );
  await waitForAgentReply(threadPanel, followupReply);

  await page.screenshot({
    path: "/tmp/buzz-web-orca-agent-proof.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      agentName,
      channelName,
      firstReply,
      followupReply,
      result: "passed",
    }),
  );
} catch (error) {
  if (page) {
    await page.screenshot({
      path: "/tmp/buzz-web-orca-agent-failure.png",
      fullPage: true,
    });
    console.error((await page.locator("body").innerText()).slice(-4_000));
  }
  throw error;
} finally {
  await browser.close();
}
