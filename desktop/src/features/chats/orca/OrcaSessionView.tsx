import * as React from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { OrcaChatConfig } from "../chatChannel";
import { Button } from "@/shared/ui/button";
import {
  fetchManagedOrcaPairing,
  type OrcaMemberAuth,
  type OrcaPairingOffer,
} from "./pairing";
import { attachOrcaWebApp, detachOrcaWebApp } from "./sessionHost";

export function OrcaSessionView({
  channelId,
}: {
  channelId: string;
  config: OrcaChatConfig;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [pairing, setPairing] = React.useState<OrcaPairingOffer | null>(null);
  const [memberAuth, setMemberAuth] = React.useState<OrcaMemberAuth | null>(
    null,
  );
  const [worktreeId, setWorktreeId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (pairing) return;
    let cancelled = false;
    void fetchManagedOrcaPairing(channelId)
      .then((access) => {
        if (cancelled) return;
        setPairing(access.offer);
        setMemberAuth(access.auth);
        setWorktreeId(access.worktreeId);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, pairing, attempt]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !pairing || !worktreeId) return;
    let cancelled = false;
    // Orca Web's real renderer mounts here, in the light DOM. Only its auth
    // bootstrap is replaced: the Buzz runtime ticket in `pairing` rides in as
    // the pairing code.
    void attachOrcaWebApp(host, pairing, worktreeId, memberAuth)
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
  }, [pairing, worktreeId, memberAuth, attempt]);

  const retry = () => {
    setPairing(null);
    setWorktreeId(null);
    setError(null);
    setMounted(false);
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Could not connect to Orca.";
}
