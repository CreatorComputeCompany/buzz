import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deployRoot = new URL("../../../../../deploy/orca-host/", import.meta.url);

async function deploymentFile(name) {
  return readFile(new URL(name, deployRoot), "utf8");
}

test("the Buzz listener follows the Orca runtime lifecycle", async () => {
  const unit = await deploymentFile("buzz-orca-agent.service");
  assert.match(unit, /^Requires=orca-serve\.service$/m);
  assert.match(unit, /^PartOf=orca-serve\.service$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/buzz-orca-agent\.env$/m);
  assert.match(unit, /^Environment=BUZZ_ACP_RESPOND_TO=anyone$/m);
  assert.match(unit, /^Environment=BUZZ_ORCA_BASE_REF=main$/m);
  assert.doesNotMatch(unit, /^Environment=BUZZ_ORCA_BASE_REF=feat\//m);
  assert.match(
    unit,
    /^Environment=BUZZ_ACP_ALLOWED_RESPOND_TO=owner-only,allowlist,anyone$/m,
  );
});

test("runtime tickets stay in a root-owned environment file", async () => {
  const unit = await deploymentFile("orca-serve.service");
  const installer = await deploymentFile("install-services.sh");
  assert.match(unit, /^EnvironmentFile=\/etc\/orca-serve\.env$/m);
  assert.doesNotMatch(unit, /ORCA_RUNTIME_APP_TICKET_SECRET=/);
  assert.match(installer, /owner.*root/);
  assert.match(installer, /mode.*600/);
});

test("bundle deployment verifies both digests and restores both components", async () => {
  const installer = await deploymentFile("install-bundle.sh");
  assert.equal(
    (installer.match(/sha256sum --check --status/g) ?? []).length,
    2,
  );
  assert.match(installer, /mv "\$MAIN_BACKUP" "\$APP_OUT\/main"/);
  assert.match(installer, /mv "\$WEB_BACKUP" "\$APP_OUT\/web"/);
  assert.match(
    installer,
    /systemctl start orca-serve\.service buzz-orca-agent\.service/,
  );
});
