# Hosted Agent Turns

## Decision

Hosted agents use the existing Buzz relay and `buzz-acp` protocol path. The
browser never runs an agent and the web API never proxies chat messages.

The durable production unit is one supervised server process per agent
identity:

1. A server-side provisioner creates the agent keypair and NIP-OA owner
   attestation, then stores the private key encrypted at rest.
2. The provisioner publishes the agent profile and owner-signed managed-agent
   policy, and adds the identity to its configured channels with the `bot`
   role.
3. A supervisor starts `buzz-acp` with the private key, auth tag, relay URL,
   owner pubkey, access policy, and ACP child command injected at runtime.
4. `buzz-acp` subscribes directly to the hosted relay. A signed mention event
   starts a turn; the ACP child returns output; `buzz-acp` signs the reply back
   to the same relay.
5. The supervisor restarts abnormal exits. Relay presence is the user-visible
   liveness signal, and an owner-authorized clean shutdown remains terminal.

The initial deployment target is a dedicated Fly process per agent identity.
Fly secrets or an encrypted server-side record provide runtime credentials;
they are never placed in Vercel assets, browser storage, command output, or
public agent events.

Orca may later replace only the ACP child command. It does not replace
`buzz-acp`, the relay, Buzz identities, channel membership, mentions, replies,
or any frontend component.

## Acceptance

Run:

```bash
pnpm -C desktop verify:web-agent-hosted
```

The check creates a disposable NIP-OA agent identity, publishes its directory
and access policy, starts the real `buzz-acp` harness with a deterministic ACP
fixture, creates a normal web account through the visible UI, joins a shared
channel, selects the agent through mention autocomplete, and verifies the
agent's signed reply in the visible thread UI.

## Persistent web test agent

`Buzz Test Agent` runs continuously on Fly in the open `agent-playground`
channel using the real `buzz-agent` runtime with an OpenAI model. To test it
manually:

1. Open <https://buzz-web-alpha.vercel.app> and sign in.
2. Browse channels and join `agent-playground`.
3. Type `@Buzz`, select `Buzz Test Agent`, add any message, and send it.
4. Wait about 15 seconds, hover your message, and open **Reply**.
5. Confirm the thread contains a relevant AI-generated response.

Run the same production proof automatically with:

```bash
pnpm -C desktop verify:web-agent-persistent
```

The Fly service is defined in `deploy/fly/test-agent.toml`. Its stable private
key is stored in the local macOS Keychain and imported directly into Fly
secrets by `desktop/scripts/provision-hosted-test-agent.mjs`; it is never
written to the repository or browser storage.

This acceptance process is disposable and local to the test runner. It proves
the protocol and browser path; the durable Fly supervisor described above is
the production lifecycle implementation boundary.
