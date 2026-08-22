# Orca Coding Agent Plan

## Goal

Add a dedicated coding agent to Buzz whose work executes inside Orca while
preserving the existing Buzz frontend, relay, identities, mentions, threads,
and `buzz-acp` message path.

The existing `Buzz Test Agent` remains unchanged. A separate `Buzz Orca Agent`
identity provides the coding path so rollout, permissions, resource limits,
and rollback are isolated from normal conversational AI.

## Architecture

The production path is:

```text
Buzz Web/Desktop
    -> hosted Buzz relay
    -> buzz-acp (Buzz Orca Agent identity)
    -> buzz-orca-acp (stdio ACP adapter)
    -> Orca CLI
    -> paired headless Orca runtime
    -> isolated Orca worktree + Codex terminal
```

`buzz-orca-acp` is the only new protocol component. It implements the ACP
methods already consumed by `buzz-acp` and translates them into Orca's real
CLI contracts:

- `session/new` creates or restores one Orca worktree and terminal.
- `session/prompt` sends the first task or a follow-up to the terminal.
- session updates are produced from cursor-based `orca terminal read` output.
- cancellation interrupts the terminal and stops work for that worktree.
- shutdown releases the adapter without deleting durable work.

The adapter must use `orca --environment <fixed-selector>` against a paired
`orca serve` runtime. A disposable Chat may choose only a server-allowlisted
repository, provider, and model identifier. Chat input can never choose an
environment, filesystem path, model credential, or executable command.

## Durable Session Model

One Buzz conversation maps to one Orca coding session:

- Channel and DM identifiers are the stable conversation key.
- Each key maps to an Orca environment, worktree id, terminal handle, output
  cursor, and generation number.
- The first coding prompt creates an independent worktree with
  `orca worktree create --agent codex --prompt ... --no-parent --json`.
- Later prompts continue through `orca terminal send --agent-prompt`.
- The adapter waits with `orca terminal wait --for tui-idle` and reads only new
  output using the saved cursor.
- A process restart reloads mappings, verifies the worktree and terminal with
  Orca, and either resumes them or reports an explicit recoverable failure.

State must live in an encrypted server-side store or persistent volume, never
in browser storage or public relay events. A generation fence prevents output
from an abandoned terminal being posted after failover.

## Security And Limits

- Start owner-only and allowlist one test channel.
- Fix the Orca environment and allowlisted repositories/providers in deployment
  configuration.
- Keep pairing material and managed Codex credentials only on servers.
- Permit at most two concurrent coding turns initially; queue excess work.
- Bound worktree count, terminal output, turn duration, inactivity, and disk.
- Never merge, deploy, or mutate production without an explicit user request.
- Treat terminal output as untrusted and preserve Buzz's signed-reply boundary.
- Keep a one-setting rollback to the current `buzz-agent` child command.

## Implementation Phases

### 1. Contract Spike

- Start `orca serve` locally in headless mode.
- Pair a separate CLI environment and register one disposable repository.
- Prove worktree create, terminal idle wait, cursor reads, follow-up input,
  interruption, and cleanup entirely through documented Orca CLI commands.
- Record exact JSON shapes and failure modes as adapter fixtures.

### 2. ACP Adapter

- Add a small `buzz-orca-acp` binary with no relay or Nostr responsibilities.
- Implement ACP initialize, session creation, prompt, cancellation, and shutdown.
- Translate Orca terminal output into bounded ACP updates and one final response.
- Add deterministic fake-Orca tests for startup, continuation, cancellation,
  timeout, malformed JSON, lost terminals, and duplicate delivery.

### 3. Durable Runtime

- Run a dedicated headless Orca host that does not depend on a developer laptop.
- Pair the hosted adapter to that environment using server-held credentials.
- Add persistent conversation mappings, generation fencing, reconciliation,
  concurrency limits, inactivity cleanup, health checks, and structured logs.
- Provision a separate owner-managed `Buzz Orca Agent` relay identity.

### 4. Production Rollout

- Deploy `buzz-acp` with `buzz-orca-acp` as the child command for only the new
  coding-agent identity.
- Enable one owner-only test channel, then one explicitly allowlisted teammate.
- Keep `Buzz Test Agent` and the current OpenAI-backed path unchanged.
- Document restart, terminal cleanup, worktree cleanup, credential rotation,
  and rollback procedures.

## Acceptance Run

A recorded production run must prove all of the following through the visible
Buzz Web UI:

1. Mentioning `Buzz Orca Agent` with a read-only coding task creates one isolated
   Orca worktree and returns the verified result in the same Buzz thread.
2. A follow-up message continues in the same Orca terminal and worktree.
3. A second Buzz channel creates a different worktree with no context leakage.
4. Cancellation from Buzz interrupts the active terminal and posts a terminal
   cancelled state exactly once.
5. Restarting the adapter during a turn reconciles or resumes without duplicate
   replies; restarting while idle preserves the next follow-up.
6. An edit task produces the expected diff, while push, merge, and deployment do
   not occur unless the user explicitly requests them.
7. Invalid repository, environment, command, and cross-session access attempts
   are rejected before Orca execution.
8. The full path survives refresh and another browser account, with all visible
   replies still signed by the managed Buzz agent identity.
9. The headless Orca host, Buzz relay path, and coding task continue with the
   developer laptop offline.
10. Switching the child command back to `buzz-agent` restores the previous agent
    runtime without frontend, relay, membership, or identity changes.

## Definition Of Done

This stage is complete only when the acceptance run passes twice: once from a
clean deployment and once across an intentional adapter restart. Unit tests,
typechecks, release builds, health checks, secret scanning, and the existing
Buzz Web acceptance suite must also pass.
