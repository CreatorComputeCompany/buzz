# Buzz Web Client

## Product constraint

Buzz Web is the existing Buzz desktop React application running in a browser.
It is not a separate UI and must not reimplement or approximate Buzz screens.

## Current milestone

The `web-preview` Vite mode packages the real desktop application with Buzz's
existing browser test bridge. This makes the complete UI navigable in a normal
browser while keeping the desktop component tree unchanged.

```bash
cd desktop
pnpm build:web-preview
pnpm preview:web
```

The preview uses deterministic local fixture data. It is a UI and browser
packaging proof, not the production collaboration client.

## Existing production seam

Buzz's E2E relay mode already runs the same React application against a real
`buzz-relay` from Chromium. The relay-backed suite proves channel discovery,
message sending, realtime delivery between browser contexts, DMs, threads,
reactions, and reconnection without changing the UI.

The production web client should promote that seam by replacing only these
test-owned boundaries:

1. Test identities -> server-authenticated browser identities.
2. Test key material -> non-exportable or server-held signing credentials.
3. Tauri local persistence -> browser storage and authenticated server state.
4. Native notifications, files, and deep links -> web platform adapters.
5. Test bridge activation -> a production browser bridge selected at build
   time.

The relay protocol, application stores, routes, components, styling, and
interaction behaviour remain Buzz-owned and shared with desktop.

## Guardrails

- Do not copy Buzz components into another frontend.
- Do not add a parallel room or message model.
- Do not route messages through Vercel functions.
- Do not expose Nostr keys, relay URLs, or pairing controls to normal users.
- Do not call the fixture-backed preview a production chat client.
