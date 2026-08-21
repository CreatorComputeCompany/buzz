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

const port = Number(process.env.PORT ?? 3000);

function orcaRuntimeAllowedUserIds(): Set<string> {
  return new Set(
    (process.env.BUZZ_ORCA_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
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
    if (!orcaRuntimeAllowedUserIds().has(session.user.id)) {
      return Response.json({ error: "orca_access_denied" }, { status: 403 });
    }
    const pairingUrl = process.env.BUZZ_ORCA_PAIRING_URL;
    if (!pairingUrl) {
      return Response.json(
        { error: "orca_runtime_unavailable" },
        { status: 503 },
      );
    }
    return Response.json(
      { pairingUrl },
      { headers: { "Cache-Control": "no-store, private" } },
    );
  }

  return new Response("Not found", { status: 404 });
}

await migrateAuthDatabase();

createServer(async (incoming, outgoing) => {
  try {
    const response = await route(await toWebRequest(incoming));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
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
