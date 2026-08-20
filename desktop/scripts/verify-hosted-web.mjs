import { chromium } from "@playwright/test";

const baseUrl = process.env.BUZZ_WEB_URL ?? "https://buzz-web-alpha.vercel.app";
const password = process.env.BUZZ_WEB_TEST_PASSWORD ?? "test-password-48291";
const runId = Date.now();
const channelName = `web-proof-${runId}`;
const aliceMessage = `Hello from Alice ${runId}`;
const bobMessage = `Hello from Bob ${runId}`;

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

async function sendMessage(page, message) {
  const composer = page.getByTestId("message-composer");
  await composer.locator('[contenteditable="true"]').fill(message);
  await page.getByTestId("send-message").click();
}

try {
  await signUp(alice, "Alice Web");
  await signUp(bob, "Bob Web");
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

  await alice.screenshot({
    path: "/tmp/buzz-web-two-user-proof.png",
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      baseUrl,
      channelName,
      messages: [aliceMessage, bobMessage],
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
    (await alice.locator("body").innerText()).slice(-2_000),
  );
  console.error(
    "Bob page:",
    (await bob.locator("body").innerText()).slice(-2_000),
  );
  console.error("Browser diagnostics:", diagnostics.join("\n"));
  throw error;
} finally {
  await browser.close();
}
