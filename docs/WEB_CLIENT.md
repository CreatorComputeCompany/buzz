# Buzz Web Client

## Product constraint

Buzz Web is the existing Buzz desktop React application running in a browser.
It is not a separate UI and must not reimplement or approximate Buzz screens.

## Production web client

The `web-client` Vite mode packages the real desktop application for production
without changing Buzz's component tree, routes, stores, or collaboration model.
It is live at <https://buzz-web-alpha.vercel.app>.

```bash
pnpm -C desktop build:web-client
```

Normal email/password authentication is provided by Better Auth. The Fly web
API maps each account to an encrypted, server-held Nostr identity and publishes
only signed events. The browser receives the account's public key and an
authenticated signing endpoint; it never receives the private key.

Both Buzz Web and Buzz desktop speak the existing Buzz protocol directly to the
hosted relay at `wss://imabird-buzz-relay.fly.dev`. Vercel serves only the
static frontend and proxies authentication/signing requests to the Fly web API.

Run the production acceptance check with:

```bash
pnpm -C desktop verify:web-hosted
```

The check creates two ordinary accounts through the visible sign-up UI, creates
and joins one shared channel through Buzz's channel browser, exchanges a message
in each direction, and verifies realtime delivery in both browser contexts.

## Existing production seam

Buzz's E2E relay mode already runs the same React application against a real
`buzz-relay` from Chromium. The relay-backed suite proves channel discovery,
message sending, realtime delivery between browser contexts, DMs, threads,
reactions, and reconnection without changing the UI.

The production web client promotes that seam by replacing only these
platform-owned boundaries:

1. Test identities -> Better Auth browser sessions.
2. Test key material -> encrypted server-held signing credentials.
3. Tauri local persistence -> browser storage and authenticated server state.
4. Native notifications, files, and deep links -> web platform adapters.
5. Test bridge activation -> the explicit `web-client` build mode.

The relay protocol, application stores, routes, components, styling, and
interaction behaviour remain Buzz-owned and shared with desktop.

## Real relay preview

The exact frontend can also run against a real local `buzz-relay`:

```bash
VITE_BUZZ_RELAY_URL=ws://localhost:3030 pnpm -C desktop build:web-relay-preview
pnpm -C desktop preview:web
```

Open the default Tyler profile at `http://localhost:4173/`. To prove two
independent browser identities, open a second isolated browser profile at
`http://localhost:4173/?previewUser=alice`. Both profiles use the same relay,
channels, and persisted event history.

This mode uses the relay-backed browser transport exercised by Buzz's
integration suite. It is deliberately restricted to loopback relays because
Tyler and Alice are deterministic local test identities whose keys are present
in the preview bundle. It must not be deployed.

## Guardrails

- Do not copy Buzz components into another frontend.
- Do not add a parallel room or message model.
- Do not route messages through Vercel functions.
- Do not expose Nostr keys, relay URLs, or pairing controls to normal users.
- Do not call the fixture-backed preview a production chat client.
