// The OpenCode global-config edit must be minimal and fully reversible.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addBbToolsRule,
  removeBbToolsRule,
  syncBbToolsRule,
} from "./test-host-api.js";

const RULE =
  '{ "action": "bb_opencode2_*", "resource": "*", "effect": "deny" }';

const cases: Record<string, string> = {
  "no permissions key": `{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": "notify",
  "plugins": [],
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" }
  }
}
`,
  "existing rules": `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git status *", "effect": "allow" }
  ],
  "autoupdate": true
}
`,
  "empty permissions": `{
  "permissions": [],
  "autoupdate": true
}
`,
  "jsonc with comments and trailing comma": `// my config
{
  /* keep me */
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" }, // ask first
  ],
  "theme": "dark", // trailing
}
`,
  "empty object": "{}\n",
};

for (const [name, original] of Object.entries(cases)) {
  test(`adds one rule last and removes it exactly: ${name}`, () => {
    const added = addBbToolsRule(original);
    assert.ok(added);
    // Only additions: every original character survives in order.
    let cursor = 0;
    for (const ch of original) {
      cursor = added.indexOf(ch, cursor);
      assert.notEqual(cursor, -1);
      cursor++;
    }
    assert.equal(added.split(RULE).length, 2);
    if (!name.startsWith("jsonc")) {
      const parsed = JSON.parse(added);
      assert.deepEqual(parsed.permissions.at(-1), {
        action: "bb_opencode2_*",
        resource: "*",
        effect: "deny",
      });
      const { permissions: _, ...rest } = parsed;
      const { permissions: __, ...before } = JSON.parse(original);
      assert.deepEqual(rest, before);
    }
    assert.equal(addBbToolsRule(added), undefined, "idempotent");
    // Without a record (file edited since), only the rule is cut.
    const cut = removeBbToolsRule(added);
    assert.ok(cut && !cut.includes("bb_opencode2_"));
    if (!name.startsWith("jsonc")) {
      const { permissions = [], ...rest } = JSON.parse(cut);
      const { permissions: before = [], ...beforeRest } = JSON.parse(original);
      assert.deepEqual(rest, beforeRest);
      assert.deepEqual(permissions, before);
    }
    assert.equal(removeBbToolsRule(original), undefined);
  });

  test(`restores the file byte-for-byte when untouched: ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-config-"));
    const path = join(dir, "opencode.json");
    const state = join(dir, "edit.json");
    writeFileSync(path, original);
    assert.equal(await syncBbToolsRule(true, path, state), "added");
    assert.equal(await syncBbToolsRule(false, path, state), "removed");
    assert.equal(readFileSync(path, "utf8"), original);
  });
}

test("cuts only the rule when the user edited the file in between", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-config-"));
  const path = join(dir, "opencode.json");
  const state = join(dir, "edit.json");
  writeFileSync(path, cases["existing rules"]);
  await syncBbToolsRule(true, path, state);
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      '"autoupdate": true',
      '"autoupdate": false',
    ),
  );
  assert.equal(await syncBbToolsRule(false, path, state), "removed");
  assert.equal(
    readFileSync(path, "utf8"),
    cases["existing rules"].replace(
      '"autoupdate": true',
      '"autoupdate": false',
    ),
  );
});

test("removes a config file it created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-config-"));
  const path = join(dir, "opencode.json");
  const state = join(dir, "edit.json");
  assert.equal(await syncBbToolsRule(true, path, state), "added");
  assert.ok(JSON.parse(readFileSync(path, "utf8")).permissions);
  assert.equal(await syncBbToolsRule(false, path, state), "removed");
  assert.equal(existsSync(path), false);
});

test("writes only on change, keeps the file mode, and reverses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-config-"));
  const path = join(dir, "opencode.json");
  const original = cases["no permissions key"];
  writeFileSync(path, original);
  chmodSync(path, 0o600);
  assert.equal(await syncBbToolsRule(true, path), "added");
  assert.equal(await syncBbToolsRule(true, path), "unchanged");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(await syncBbToolsRule(false, path), "removed");
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(await syncBbToolsRule(false, path), "unchanged");
});
