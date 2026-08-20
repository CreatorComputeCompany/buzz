import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@/app/App";
import { RootErrorBoundary } from "@/app/RootErrorBoundary";
import { NostrBindConsentDialog } from "@/features/profile/ui/NostrBindConsentDialog";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@/shared/styles/globals.css";
import { UpdaterProvider } from "@/features/settings/hooks/UpdaterProvider";
import { migrateLegacyCommunityStorageBeforeRender } from "@/features/communities/legacyCommunityStorage";
import { CommunitiesProvider } from "@/features/communities/useCommunities";
import { huddleWindowChannelId } from "@/features/huddle/lib/huddleWindow";
import { CommunityOnboardingProvider } from "@/features/onboarding/communityOnboarding";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { EmojiBurstProvider } from "@/shared/ui/EmojiBurstProvider";
import { PoofBurstProvider } from "@/shared/ui/PoofBurstProvider";
import { Toaster } from "@/shared/ui/sonner";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { recoverLocalStorageQuotaOnStartup } from "@/shared/lib/localStorageQuota";
import { startLocalStorageSweep } from "@/shared/lib/localStorageSweep";
import { initializeConversationDensityPreference } from "@/shared/lib/conversationDensityPreference";
import { initializeFontSizePreference } from "@/shared/lib/fontSizePreference";

type E2eWindow = Window & {
  __BUZZ_E2E__?: unknown;
};

const E2E_DEFAULT_PUBKEY = "deadbeef".repeat(8);
const E2E_COMMUNITY_ID = "e2e-default-community";
const ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX = "buzz-onboarding-complete.v1:";
const DEV_STATE_RESET_PARAM = "resetDevState";
const WEB_PREVIEW_MODE = "web-preview";
const WEB_RELAY_PREVIEW_MODE = "web-relay-preview";

function requireLoopbackRelayUrl(value: string | undefined): URL {
  if (!value) {
    throw new Error(
      "VITE_BUZZ_RELAY_URL is required for the web relay preview build.",
    );
  }

  const relayUrl = new URL(value);
  if (
    relayUrl.protocol !== "ws:" ||
    (relayUrl.hostname !== "localhost" && relayUrl.hostname !== "127.0.0.1")
  ) {
    throw new Error(
      "The web relay preview accepts only a local ws:// relay. Hosted identity and auth are not implemented yet.",
    );
  }

  return relayUrl;
}

function resetDevWebviewStateFromUrl() {
  if (!import.meta.env.DEV) {
    return;
  }

  const url = new URL(window.location.href);
  if (url.searchParams.get(DEV_STATE_RESET_PARAM) !== "1") {
    return;
  }

  // WebKit groups every Buzz binary under one disk directory, but storage is
  // isolated by origin. Clearing here resets only this dev server's origin;
  // deleting the shared WebKit directory would also destroy installed-app state.
  window.localStorage.clear();
  window.sessionStorage.clear();
  url.searchParams.delete(DEV_STATE_RESET_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

async function configureBrowserBridge() {
  const isWebPreview = import.meta.env.MODE === WEB_PREVIEW_MODE;
  const isWebRelayPreview = import.meta.env.MODE === WEB_RELAY_PREVIEW_MODE;
  if (!import.meta.env.DEV && !isWebPreview && !isWebRelayPreview) {
    return;
  }

  const url = new URL(window.location.href);
  if (
    !isWebPreview &&
    !isWebRelayPreview &&
    url.searchParams.get("e2e") !== "mock"
  ) {
    return;
  }

  const e2eWindow = window as E2eWindow;
  const relayUrl = isWebRelayPreview
    ? requireLoopbackRelayUrl(import.meta.env.VITE_BUZZ_RELAY_URL)
    : null;
  const relayIdentity = relayUrl
    ? (
        await import("@/testing/webRelayPreviewIdentity")
      ).selectWebRelayPreviewIdentity(url.searchParams)
    : null;
  e2eWindow.__BUZZ_E2E__ ??= relayUrl
    ? {
        identity: relayIdentity ?? undefined,
        mode: "relay",
        relayHttpUrl: relayUrl.href.replace(/^ws:/, "http:").replace(/\/$/, ""),
        relayWsUrl: relayUrl.href.replace(/\/$/, ""),
      }
    : { mode: "mock" };

  const community = {
    addedAt: new Date().toISOString(),
    id: E2E_COMMUNITY_ID,
    name: relayUrl ? "Local Buzz" : "E2E Test",
    pubkey: relayIdentity?.pubkey ?? E2E_DEFAULT_PUBKEY,
    relayUrl: relayUrl?.href.replace(/\/$/, "") ?? "ws://localhost:3000",
  };
  window.localStorage.setItem("buzz-communities", JSON.stringify([community]));
  window.localStorage.setItem("buzz-active-community-id", E2E_COMMUNITY_ID);
  window.localStorage.setItem(
    `${ONBOARDING_COMPLETION_STORAGE_KEY_PREFIX}${relayIdentity?.pubkey ?? E2E_DEFAULT_PUBKEY}`,
    "true",
  );
}

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* block/buzz#5078 — catch any uncaught render error so a WebKit
          SecurityError from localStorage can't blank the whole window. */}
      <RootErrorBoundary>
        <CommunitiesProvider>
          <CommunityOnboardingProvider
            enabled={huddleWindowChannelId() === null}
          >
            <ThemeProvider defaultTheme="buzz">
              <TooltipProvider>
                <EmojiBurstProvider>
                  <PoofBurstProvider>
                    <UpdaterProvider>
                      <App />
                      <NostrBindConsentDialog />
                    </UpdaterProvider>
                    <Toaster />
                  </PoofBurstProvider>
                </EmojiBurstProvider>
              </TooltipProvider>
            </ThemeProvider>
          </CommunityOnboardingProvider>
        </CommunitiesProvider>
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}

async function installE2eBridgeIfConfigured() {
  // The mock bridge is compiled only into dev and explicit E2E builds. A
  // pre-bootstrap global alone must never activate mock IPC in production.
  if (
    !(
      import.meta.env.DEV ||
      import.meta.env.MODE === "e2e" ||
      import.meta.env.MODE === WEB_PREVIEW_MODE ||
      import.meta.env.MODE === WEB_RELAY_PREVIEW_MODE
    ) ||
    !(window as E2eWindow).__BUZZ_E2E__
  ) {
    return;
  }

  const { maybeInstallE2eTauriMocks } = await import("@/testing/e2eBridge");
  maybeInstallE2eTauriMocks();
}

async function bootstrap() {
  resetDevWebviewStateFromUrl();
  await configureBrowserBridge();
  recoverLocalStorageQuotaOnStartup();
  initializeConversationDensityPreference();
  initializeFontSizePreference();
  startLocalStorageSweep();
  await installE2eBridgeIfConfigured();
  await migrateLegacyCommunityStorageBeforeRender();
  renderApp();
}

void bootstrap();
