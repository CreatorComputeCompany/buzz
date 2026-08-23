import { createServer, type IncomingMessage } from "node:http";
import { auth, migrateAuthDatabase, requireSession } from "./auth.js";
import {
  ensureIdentity,
  ensureRelayMembership,
  ensureRelayProfile,
  RELAY_WS_URL,
  signTemplate,
  validateEventTemplate,
} from "./identity.js";
import { isOrcaRuntimeUserAllowed } from "./orca-access.js";
import {
  toOrcaRuntimeResponse,
  type OrcaRuntimeTicket,
} from "./orca-ticket-response.js";
import {
  bootstrapOrcaChat,
  getOrcaChatHistory,
  sendOrcaChatMessage,
} from "./orca-chat.js";
import { authorizeOrcaChatBridge } from "./orca-chat-shapes.js";

const port = Number(process.env.PORT ?? 3000);

function orcaRuntimeHttpBase(pairingUrl: string): string | null {
  try {
    const code = new URL(pairingUrl).searchParams.get("code");
    if (!code) return null;
    const offer = JSON.parse(
      Buffer.from(code, "base64url").toString("utf8"),
    ) as { endpoint?: string };
    if (!offer.endpoint) return null;
    const endpoint = new URL(offer.endpoint);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    return `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

async function mintOrcaTicket(
  pairingUrl: string,
  identity: { pubkey: string },
  user: { email: string; name: string },
  channelId: string,
): Promise<OrcaRuntimeTicket | null> {
  const secret = process.env.BUZZ_ORCA_APP_TICKET_SECRET;
  const issuer = process.env.BUZZ_ORCA_IDENTITY_ISSUER ?? "https://buzz.chat";
  if (!secret) return null;
  const base = orcaRuntimeHttpBase(pairingUrl);
  if (!base) return null;
  try {
    const response = await fetch(`${base}/api/runtime/app-ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: identity.pubkey,
        name: user.name,
        email: user.email,
        issuer,
        channelId,
      }),
    });
    if (!response.ok) return null;
    return (await response.json()) as OrcaRuntimeTicket;
  } catch {
    return null;
  }
}

function requestUrl(request: IncomingMessage): string {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  const protocol = request.headers["x-forwarded-proto"] ?? "https";
  return `${protocol}://${host}${request.url ?? "/"}`;
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  if (request.method !== "GET" && request.method !== "HEAD") {
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(requestUrl(request), {
    method: request.method,
    headers: request.headers as HeadersInit,
    body,
  });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/_liveness") return new Response("ok");
  if (url.pathname.startsWith("/api/auth/")) return auth.handler(request);

  if (url.pathname.startsWith("/api/internal/orca-chat/")) {
    if (!authorizeOrcaChatBridge(request.headers.get("authorization"))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const result =
        url.pathname === "/api/internal/orca-chat/bootstrap"
          ? await bootstrapOrcaChat(body.actor)
          : url.pathname === "/api/internal/orca-chat/history"
            ? await getOrcaChatHistory(body.actor, body.channelId)
            : url.pathname === "/api/internal/orca-chat/send"
              ? await sendOrcaChatMessage(
                  body.actor,
                  body.channelId,
                  body.content,
                )
              : null;
      return result
        ? Response.json(result, { headers: { "Cache-Control": "no-store" } })
        : Response.json({ error: "not_found" }, { status: 404 });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "chat_unavailable";
      const status = message.startsWith("invalid_")
        ? 400
        : message === "channel_not_accessible"
          ? 403
          : 503;
      return Response.json({ error: message }, { status });
    }
  }

  const session = await requireSession(request);
  if (!session) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }

  if (url.pathname === "/api/buzz/session" && request.method === "GET") {
    const identity = await ensureIdentity(session.user.id);
    await ensureRelayMembership(session.user.id, identity);
    await ensureRelayProfile(identity, session.user.name);
    return Response.json({
      pubkey: identity.pubkey,
      username: session.user.name,
      relayHttpUrl: RELAY_WS_URL.replace(/^wss:/, "https:"),
      relayWsUrl: RELAY_WS_URL,
      signerUrl: "/api/buzz/sign",
    });
  }

  if (url.pathname === "/api/buzz/sign" && request.method === "POST") {
    try {
      const template = validateEventTemplate(await request.json());
      const identity = await ensureIdentity(session.user.id);
      return Response.json(signTemplate(identity, template));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to sign event";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (url.pathname === "/api/buzz/orca-runtime" && request.method === "GET") {
    if (!isOrcaRuntimeUserAllowed(session.user.id)) {
      return Response.json({ error: "orca_access_denied" }, { status: 403 });
    }
    const pairingUrl = process.env.BUZZ_ORCA_PAIRING_URL;
    const channelId = url.searchParams.get("channelId");
    if (!channelId || !/^[0-9a-f-]{36}$/i.test(channelId)) {
      return Response.json({ error: "invalid_channel" }, { status: 400 });
    }
    if (!pairingUrl) {
      return Response.json(
        { error: "orca_runtime_unavailable" },
        { status: 503 },
      );
    }
    const identity = await ensureIdentity(session.user.id);
    const ticket = await mintOrcaTicket(
      pairingUrl,
      identity,
      session.user,
      channelId,
    );
    if (!ticket) {
      return Response.json(
        { error: "orca_worktree_access_denied" },
        { status: 403 },
      );
    }
    return Response.json(toOrcaRuntimeResponse(ticket), {
      headers: { "Cache-Control": "no-store, private" },
    });
  }

  return new Response("Not found", { status: 404 });
}

await migrateAuthDatabase();

createServer(async (incoming, outgoing) => {
  try {
    const response = await route(await toWebRequest(incoming));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => {
      outgoing.setHeader(name, value);
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) outgoing.setHeader("set-cookie", setCookies);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.statusCode = 500;
    outgoing.end("Internal server error");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Buzz web API listening on ${port}`);
});
