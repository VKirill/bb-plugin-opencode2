// Updating OpenCode v2 in place: an npm install is updated in its own prefix.
import assert from "node:assert/strict";
import test from "node:test";
import { npmPrefixOf, updateCommand } from "./support/host-api.js";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("a separate npm prefix is updated in that prefix", () => {
  const real = "/home/u/.local/share/opencode2-npm/lib/node_modules/@opencode/cli/bin/opencode.exe";
  assert.equal(npmPrefixOf(real), "/home/u/.local/share/opencode2-npm");
  assert.deepEqual(updateCommand("/home/u/.local/bin/opencode2", real), {
    command: npm,
    args: ["install", "-g", "@opencode/cli@latest", "--prefix", "/home/u/.local/share/opencode2-npm"],
    displayCommand: `${npm} install -g @opencode/cli@latest --prefix /home/u/.local/share/opencode2-npm`,
  });
});

test("npm's global prefix is named too, so the update lands where opencode2 points", () => {
  const real = "/opt/homebrew/lib/node_modules/@opencode/cli/bin/opencode.exe";
  assert.deepEqual(updateCommand("/opt/homebrew/bin/opencode2", real).args.slice(-2), ["--prefix", "/opt/homebrew"]);
});

test("a prefix with spaces is quoted in the shown command", () => {
  const real = "/Users/a b/npm/lib/node_modules/@opencode/cli/bin/opencode.exe";
  assert.match(updateCommand("/x/opencode2", real).displayCommand, /--prefix '\/Users\/a b\/npm'$/u);
});

test("anything not installed by npm keeps `opencode2 upgrade`", () => {
  assert.equal(npmPrefixOf("/home/u/.opencode/bin/opencode"), null);
  assert.deepEqual(updateCommand("/home/u/.opencode/bin/opencode2", "/home/u/.opencode/bin/opencode"), {
    command: "/home/u/.opencode/bin/opencode2",
    args: ["upgrade"],
    displayCommand: "opencode2 upgrade",
  });
  assert.deepEqual(updateCommand(null, null).args, ["upgrade"]);
});
