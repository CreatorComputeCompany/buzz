export type OrcaPairingOffer = {
  v: 2;
  endpoint: string;
  deviceToken: string;
  publicKeyB64: string;
  pairedDeviceId?: string;
  scope?: "mobile" | "runtime";
};

export function parseOrcaPairingInput(input: string): OrcaPairingOffer | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const code = trimmed.toLowerCase().startsWith("orca://")
      ? extractPairingCode(trimmed)
      : trimmed;
    if (!code) return null;
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(code)),
    ) as Partial<OrcaPairingOffer>;
    if (
      parsed.v !== 2 ||
      !parsed.endpoint ||
      !parsed.deviceToken ||
      !parsed.publicKeyB64
    ) {
      return null;
    }
    return {
      v: 2,
      endpoint: normalizeWebSocketEndpoint(parsed.endpoint),
      deviceToken: parsed.deviceToken,
      publicKeyB64: parsed.publicKeyB64,
      ...(parsed.pairedDeviceId
        ? { pairedDeviceId: parsed.pairedDeviceId }
        : {}),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
    };
  } catch {
    return null;
  }
}

export type OrcaMemberAuth = {
  pairingUrl: string;
  email: string;
  member: { key: string; displayName: string };
};

export type OrcaRuntimeAccess = {
  offer: OrcaPairingOffer;
  auth: OrcaMemberAuth | null;
  worktreeId: string;
};

export async function fetchManagedOrcaPairing(
  channelId: string,
): Promise<OrcaRuntimeAccess> {
  const response = await fetch(
    `/api/buzz/orca-runtime?channelId=${encodeURIComponent(channelId)}`,
    {
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Orca Session access is not enabled for this account."
        : "Could not connect to the Orca runtime.",
    );
  }
  const payload = (await response.json()) as {
    pairingUrl?: unknown;
    orcaAuth?: unknown;
    worktreeId?: unknown;
  };
  const offer =
    typeof payload.pairingUrl === "string"
      ? parseOrcaPairingInput(payload.pairingUrl)
      : null;
  if (!offer) throw new Error("The Orca runtime returned invalid access.");
  if (typeof payload.worktreeId !== "string" || !payload.worktreeId) {
    throw new Error("The Orca runtime did not return the chat worktree.");
  }
  return {
    offer,
    auth: parseOrcaMemberAuth(payload.orcaAuth),
    worktreeId: payload.worktreeId,
  };
}

function parseOrcaMemberAuth(value: unknown): OrcaMemberAuth | null {
  const auth = value as Partial<OrcaMemberAuth> | null;
  return typeof auth?.pairingUrl === "string" &&
    typeof auth.email === "string" &&
    typeof auth.member?.key === "string" &&
    typeof auth.member.displayName === "string"
    ? (auth as OrcaMemberAuth)
    : null;
}

function extractPairingCode(input: string): string | null {
  const url = new URL(input);
  if (
    url.protocol !== "orca:" ||
    url.hostname !== "pair" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return null;
  }
  return url.searchParams.get("code") ?? url.hash.slice(1) ?? null;
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = globalThis.atob(
    base64.padEnd(Math.ceil(base64.length / 4) * 4, "="),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function normalizeWebSocketEndpoint(endpoint: string): string {
  if (endpoint.startsWith("http://")) return `ws://${endpoint.slice(7)}`;
  if (endpoint.startsWith("https://")) return `wss://${endpoint.slice(8)}`;
  return endpoint;
}
