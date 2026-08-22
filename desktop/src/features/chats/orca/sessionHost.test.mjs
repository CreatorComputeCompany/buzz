import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeOrcaPairingCode,
  orcaHttpBaseUrl,
  parseOrcaWebIndexAssets,
  scopeOrcaWebCss,
} from "./sessionHost.ts";

test("derives the runtime's HTTP base URL from its WebSocket endpoint", () => {
  assert.equal(
    orcaHttpBaseUrl("wss://orca.example.com").toString(),
    "https://orca.example.com/",
  );
  assert.equal(
    orcaHttpBaseUrl("ws://127.0.0.1:6768/orca").toString(),
    "http://127.0.0.1:6768/orca/",
  );
});

test("encodes a pairing offer the way Orca's web bootstrap decodes it", () => {
  const offer = {
    v: 2,
    endpoint: "wss://orca.example.com",
    deviceToken: "token",
    publicKeyB64: "key",
    scope: "runtime",
  };
  const code = encodeOrcaPairingCode(offer);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  const decoded = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  assert.deepEqual(decoded, offer);
});

test("finds the module entry and stylesheets in the built web index", () => {
  const html = [
    '<script type="module" crossorigin src="./assets/web-abc.js"></script>',
    '<link rel="modulepreload" crossorigin href="./assets/chunk-a.js">',
    '<link rel="stylesheet" crossorigin href="./assets/app-def.css">',
  ].join("\n");
  assert.deepEqual(parseOrcaWebIndexAssets(html), {
    entry: "./assets/web-abc.js",
    stylesheets: ["./assets/app-def.css"],
  });
  assert.equal(parseOrcaWebIndexAssets("<html></html>"), null);
});

test("scopes document-level selectors onto the embed container", () => {
  const stylesheetUrl = new URL("https://orca.example.com/assets/app.css");
  const scoped = scopeOrcaWebCss(
    ":root{--background:#fff}.dark{--background:#000}" +
      "html.native-shell .app-layout{height:100%}" +
      "body{margin:0}.flex{display:flex}" +
      ":is(.dark *){color:red}.darken{opacity:.5}",
    stylesheetUrl,
  );
  assert.equal(
    scoped,
    "[data-orca-web-embed]{--background:#fff}" +
      "[data-orca-web-embed].dark{--background:#000}" +
      "[data-orca-web-embed].native-shell .app-layout{height:100%}" +
      "[data-orca-web-embed]{margin:0}.flex{display:flex}" +
      ":is([data-orca-web-embed].dark *){color:red}.darken{opacity:.5}",
  );
});

test("rewrites viewport units to container-query units", () => {
  const stylesheetUrl = new URL("https://orca.example.com/assets/app.css");
  assert.equal(
    scopeOrcaWebCss(
      ".a{height:100dvh;min-height:50svh;max-height:25lvh;width:100vw}" +
        ".b{height:calc(100vh - 48px)}.c{--x:10vh}.overhang{margin:1evh}",
      stylesheetUrl,
    ),
    ".a{height:100cqh;min-height:50cqh;max-height:25cqh;width:100cqw}" +
      ".b{height:calc(100cqh - 48px)}.c{--x:10cqh}.overhang{margin:1evh}",
  );
});

test("absolutizes relative asset URLs against the stylesheet URL", () => {
  const stylesheetUrl = new URL("https://orca.example.com/assets/app.css");
  const scoped = scopeOrcaWebCss(
    "@font-face{src:url('./fonts/Geist.woff2')}" +
      ".a{background:url(data:image/png;base64,x)}" +
      ".b{background:url(https://cdn.example.com/x.png)}",
    stylesheetUrl,
  );
  assert.equal(
    scoped,
    "@font-face{src:url('https://orca.example.com/assets/fonts/Geist.woff2')}" +
      ".a{background:url(data:image/png;base64,x)}" +
      ".b{background:url(https://cdn.example.com/x.png)}",
  );
});
