import type { OrcaMemberAuth, OrcaPairingOffer } from "./pairing";

export type OrcaWebEmbedHandle = {
  container: HTMLElement;
  pairingCode: string;
  authResult?: OrcaMemberAuth;
  controller?: { focusWorktree: (worktreeId: string) => void };
};

export type OrcaWebIndexAssets = { entry: string; stylesheets: string[] };

const EMBED_SCOPE_ATTRIBUTE = "data-orca-web-embed";
const EMBED_SCOPE_SELECTOR = `[${EMBED_SCOPE_ATTRIBUTE}]`;

export function orcaHttpBaseUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

export function encodeOrcaPairingCode(offer: OrcaPairingOffer): string {
  const bytes = new TextEncoder().encode(JSON.stringify(offer));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function parseOrcaWebIndexAssets(
  html: string,
): OrcaWebIndexAssets | null {
  const entry = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
  if (!entry) return null;
  const stylesheets = [
    ...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g),
  ].map((match) => match[1]);
  return { entry, stylesheets };
}

/**
 * Rewrite Orca's global stylesheet so it themes only the embed subtree.
 * Orca's utility classes stay unscoped: both apps ship stock Tailwind, so the
 * declarations match and the theme resolves through CSS variables, which this
 * rewrite pins to the embed container. Only the document-level anchors
 * (`:root`, `:host`, `html`, `body`, `.dark`) must move onto the container so
 * neither app repaints the other.
 */
export function scopeOrcaWebCss(css: string, stylesheetUrl: URL): string {
  const withAbsoluteAssets = css.replace(
    /url\((['"]?)(?!data:|blob:|https?:|#)([^'")]+)\1\)/g,
    (_match, quote: string, assetPath: string) =>
      `url(${quote}${new URL(assetPath, stylesheetUrl).toString()}${quote})`,
  );
  return withAbsoluteAssets
    .replace(/:root\b/g, EMBED_SCOPE_SELECTOR)
    .replace(/:host\b/g, EMBED_SCOPE_SELECTOR)
    .replace(/\.dark\b/g, `${EMBED_SCOPE_SELECTOR}.dark`)
    .replace(/(^|[{},\s>+~(])html\b/g, `$1${EMBED_SCOPE_SELECTOR}`)
    .replace(/(^|[{},\s>+~(])body\b/g, `$1${EMBED_SCOPE_SELECTOR}`);
}

let bootPromise: Promise<OrcaWebEmbedHandle> | null = null;

export async function attachOrcaWebApp(
  pane: HTMLElement,
  offer: OrcaPairingOffer,
  worktreeId: string | null,
  memberAuth: OrcaMemberAuth | null = null,
): Promise<OrcaWebEmbedHandle> {
  bootPromise ??= bootOrcaWebApp(offer, memberAuth).catch((cause) => {
    bootPromise = null;
    throw cause;
  });
  const handle = await bootPromise;
  if (handle.container.parentElement !== pane) {
    pane.appendChild(handle.container);
  }
  if (worktreeId) handle.controller?.focusWorktree(worktreeId);
  return handle;
}

export function detachOrcaWebApp(pane: HTMLElement): void {
  const container = pane.querySelector(`:scope > ${EMBED_SCOPE_SELECTOR}`);
  // Why: the Orca app boots once per page. Detaching keeps the React tree and
  // runtime connections alive so reopening the view is instant.
  if (container) pane.removeChild(container);
}

async function bootOrcaWebApp(
  offer: OrcaPairingOffer,
  memberAuth: OrcaMemberAuth | null,
): Promise<OrcaWebEmbedHandle> {
  const indexUrl = new URL("web-index.html", orcaHttpBaseUrl(offer.endpoint));
  const indexResponse = await fetch(indexUrl, { cache: "no-store" });
  if (!indexResponse.ok) {
    throw new Error("This Orca runtime does not serve the web client.");
  }
  const assets = parseOrcaWebIndexAssets(await indexResponse.text());
  if (!assets) {
    throw new Error("The Orca web client index is invalid.");
  }

  for (const stylesheetPath of assets.stylesheets) {
    const stylesheetUrl = new URL(stylesheetPath, indexUrl);
    const stylesheetResponse = await fetch(stylesheetUrl);
    if (!stylesheetResponse.ok) {
      throw new Error("Could not load the Orca web client styles.");
    }
    const style = document.createElement("style");
    style.setAttribute("data-orca-web-css", stylesheetPath);
    style.textContent = scopeOrcaWebCss(
      await stylesheetResponse.text(),
      stylesheetUrl,
    );
    document.head.appendChild(style);
  }
  installEmbedOverrideStyles();

  const container = document.createElement("div");
  container.setAttribute(EMBED_SCOPE_ATTRIBUTE, "");
  mirrorColorSchemeClass(container);

  const handle: OrcaWebEmbedHandle = {
    container,
    pairingCode: encodeOrcaPairingCode(offer),
    ...(memberAuth ? { authResult: memberAuth } : {}),
  };
  (
    window as Window & { __ORCA_WEB_EMBED__?: OrcaWebEmbedHandle }
  ).__ORCA_WEB_EMBED__ = handle;
  await import(/* @vite-ignore */ new URL(assets.entry, indexUrl).toString());
  return handle;
}

function installEmbedOverrideStyles(): void {
  if (document.head.querySelector("style[data-orca-web-embed-overrides]")) {
    return;
  }
  const style = document.createElement("style");
  style.setAttribute("data-orca-web-embed-overrides", "");
  // Why: Orca's standalone shell sizes itself to the viewport; inside Buzz it
  // must fill the session pane instead.
  style.textContent = [
    `${EMBED_SCOPE_SELECTOR}{position:absolute;inset:0;overflow:hidden;background:var(--background)}`,
    `${EMBED_SCOPE_SELECTOR} .app-layout{height:100%;width:100%}`,
  ].join("\n");
  document.head.appendChild(style);
}

function mirrorColorSchemeClass(container: HTMLElement): void {
  const apply = () => {
    // Why: Buzz and embedded Orca both manage `dark`/`light` on the document
    // root; the scoped Orca styles only react to the class on the container.
    container.classList.toggle(
      "dark",
      document.documentElement.classList.contains("dark"),
    );
  };
  apply();
  new MutationObserver(apply).observe(document.documentElement, {
    attributeFilter: ["class"],
    attributes: true,
  });
}
