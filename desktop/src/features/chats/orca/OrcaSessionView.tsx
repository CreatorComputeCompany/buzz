import * as React from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { OrcaChatConfig } from "../chatChannel";
import { Button } from "@/shared/ui/button";
import { fetchManagedOrcaPairing, type OrcaPairingOffer } from "./pairing";
import { OrcaRuntimeClient } from "./runtimeClient";
import { findChatWorktrees, type OrcaWorktree } from "./sessionDiscovery";
import { attachOrcaWebApp, detachOrcaWebApp } from "./sessionHost";

const STORAGE_KEY = "buzz.orca.runtime-pairing.v1";

export function OrcaSessionView({
  channelId,
}: {
  channelId: string;
  config: OrcaChatConfig;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [pairing, setPairing] = React.useState<OrcaPairingOffer | null>(() =>
    readStoredPairing(),
  );
  const [worktree, setWorktree] = React.useState<OrcaWorktree | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (pairing) return;
    let cancelled = false;
    void fetchManagedOrcaPairing()
      .then((nextPairing) => {
        if (cancelled) return;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextPairing));
        setPairing(nextPairing);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [pairing, attempt]);

  React.useEffect(() => {
    if (!pairing) return;
    const client = new OrcaRuntimeClient(pairing);
    let cancelled = false;

    const discover = async () => {
      try {
        const listed = await client.call<{ worktrees: OrcaWorktree[] }>(
          "worktree.list",
          { limit: 500 },
        );
        if (cancelled) return;
        const discovered =
          findChatWorktrees(listed.worktrees ?? [], channelId)[0] ?? null;
        setWorktree((current) =>
          current?.id === discovered?.id ? current : discovered,
        );
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      }
    };

    void discover();
    const interval = window.setInterval(() => void discover(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      client.close();
    };
  }, [channelId, pairing, attempt]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !pairing) return;
    let cancelled = false;
    // Orca Web's real renderer mounts here, in the light DOM. Only its auth
    // bootstrap is replaced: the Buzz runtime ticket in `pairing` rides in as
    // the pairing code.
    void attachOrcaWebApp(host, pairing, worktree?.id ?? null)
      .then(() => {
        if (cancelled) return;
        setMounted(true);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
      detachOrcaWebApp(host);
    };
  }, [pairing, worktree?.id, attempt]);

  const retry = () => {
    setPairing(null);
    setWorktree(null);
    setError(null);
    setMounted(false);
    window.localStorage.removeItem(STORAGE_KEY);
    setAttempt((current) => current + 1);
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 bg-background"
      data-testid="orca-session-view"
    >
      <div className="relative min-h-0 flex-1" ref={hostRef} />
      {!mounted ? (
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-sm">
            <LoaderCircle
              className={`mb-4 h-8 w-8 text-primary ${error ? "" : "animate-spin"}`}
            />
            <h2 className="text-lg font-semibold">
              {error ? "Orca unavailable" : "Opening Orca Session"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {error ??
                (pairing
                  ? "Loading Orca's web client from the runtime."
                  : "Requesting Orca runtime access.")}
            </p>
            {error ? (
              <Button className="mt-4" onClick={retry} variant="outline">
                <RefreshCw />
                Retry
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function readStoredPairing(): OrcaPairingOffer | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as OrcaPairingOffer;
  } catch {
    return null;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Could not connect to Orca.";
}
