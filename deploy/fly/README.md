# Buzz relay on Fly.io

This deployment runs the real Buzz relay for Imabird with managed Postgres,
Upstash Redis, private Tigris object storage, and an encrypted Fly volume for
Git data.

The checked-in config contains no credentials. Fly stores all database, Redis,
S3, relay, and owner secrets. The relay is deliberately closed: clients need a
valid auth token and relay membership.

## Deploy

```bash
fly deploy --config deploy/fly/fly.toml
```

## Verify

```bash
curl -fsS https://imabird-buzz-relay.fly.dev/_liveness
fly checks list --app imabird-buzz-relay
fly logs --app imabird-buzz-relay
```

The owner private key is stored in the local macOS Keychain under the service
name `imabird-buzz-relay-owner`. It is not committed or stored in Fly.

## Provisioned production resources

- Fly app: `imabird-buzz-relay` in London (`lhr`), one always-on 1 GB machine
- Managed Postgres: `imabird-buzz-db` (`gjpkdonpxqd0yln4`), Starter plan,
  automatic backups enabled
- Upstash Redis: `imabird-buzz-redis`, pay-as-you-go with eviction enabled
- Tigris: private `imabird-buzz-media-prod` bucket
- Fly volume: encrypted `buzz_git_data`, scheduled snapshots with seven-day
  retention

Managed Postgres has a fixed $72/month charge. The relay machine, Redis,
Tigris, volume, and network transfer are billed separately according to use.

## Operations

```bash
# Health and startup logs
fly checks list --app imabird-buzz-relay
fly logs --app imabird-buzz-relay

# Postgres status and backups
fly mpg status gjpkdonpxqd0yln4
fly mpg backup list gjpkdonpxqd0yln4 --all

# Persistent Git volume
fly volumes list --app imabird-buzz-relay
```

Do not paste `fly redis status` into tickets or shared logs: Fly includes the
private connection URL in that command's output.

## Acceptance evidence

On 2026-08-20 two independent, signed Buzz identities joined the hosted
`hosted-proof` channel and exchanged messages in both directions. Each identity
read both events independently. Both events remained available after a full
relay machine restart. The public liveness endpoint, NIP-11 response, internal
readiness check, Postgres migration, Redis connection, media connection, and
Tigris Git conformance probe all passed.
