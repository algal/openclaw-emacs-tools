import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(rootDir, "dist", "cli.js");
const cliUrl = pathToFileURL(cliPath).href;
const coreUrl = pathToFileURL(path.join(rootDir, "dist", "core.js")).href;
const fakeEmacsclient = path.join(rootDir, "test", "fake-emacsclient.mjs");
const fakeLogPath = path.join(os.tmpdir(), `claw-emacs-fake-${process.pid}.log`);
process.env.FAKE_EMACSCLIENT_LOG = fakeLogPath;

async function runCli(args, options = {}) {
  const { runCli: runBuiltCli } = await import(cliUrl);
  const previousEnv = new Map();
  let stdout = "";

  for (const [key, value] of Object.entries({
    ...(options.env ?? {}),
    FAKE_EMACSCLIENT_LOG: fakeLogPath,
  })) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  let status = 1;
  try {
    status = await runBuiltCli(args, {
      writeStdout: (text) => {
        stdout += text;
      },
    });
  } finally {
    for (const [key, value] of previousEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  return {
    status,
    stdout,
    stderr: "",
    json: stdout.trim() ? JSON.parse(stdout) : undefined,
  };
}

test("CLI list emits compact JSON and accepts global flags before the command", async () => {
  const result = await runCli([
    "--emacsclient-path",
    fakeEmacsclient,
    "list",
    "--no-include-frames",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.json.tool, "emacs_list");
  assert.equal(result.json.includeFrames, false);
  assert.equal(result.json.includeWindows, true);
  assert.match(result.stdout, /^\{"ok":true/);
});

test("CLI read supports plugin-name alias and maxChars flag", async () => {
  const result = await runCli([
    "emacs_read",
    "--emacsclient-path",
    fakeEmacsclient,
    "--buffer",
    "*scratch*",
    "--view",
    "around_point",
    "--max-chars",
    "512",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.json.tool, "emacs_read");
  assert.equal(result.json.buffer, "*scratch*");
  assert.equal(result.json.requestedView, "around_point");
  assert.equal(result.json.maxChars, 512);
});

test("CLI open maps flags to plugin params", async () => {
  const result = await runCli([
    "open",
    "README.md",
    "--emacsclient-path",
    fakeEmacsclient,
    "--line",
    "3",
    "--column",
    "2",
    "--no-focus",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.json.tool, "emacs_open");
  assert.equal(path.basename(result.json.file), "README.md");
  assert.equal(result.json.line, 3);
  assert.equal(result.json.column, 2);
  assert.equal(result.json.focused, false);
});

test("CLI insert maps text, placement, and undo flags", async () => {
  const result = await runCli([
    "insert",
    "--emacsclient-path",
    fakeEmacsclient,
    "--text",
    "hello",
    "--buffer",
    "*scratch*",
    "--at",
    "eob",
    "--no-undo-boundary",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.json.tool, "emacs_insert");
  assert.equal(result.json.text, "hello");
  assert.equal(result.json.buffer, "*scratch*");
  assert.equal(result.json.at, "eob");
  assert.equal(result.json.undoBoundary, false);
});

test("CLI edit maps old_string and new_string params", async () => {
  const result = await runCli([
    "edit",
    "--emacsclient-path",
    fakeEmacsclient,
    "--buffer",
    "*scratch*",
    "--old-string",
    "old",
    "--new-string",
    "new",
  ]);

  assert.equal(result.status, 0);
  assert.equal(result.json.tool, "emacs_edit");
  assert.equal(result.json.buffer, "*scratch*");
  assert.equal(result.json.old_string, "old");
  assert.equal(result.json.new_string, "new");
});

test("CLI eval accepts the expression as a positional argument", async () => {
  const result = await runCli(["eval", "--emacsclient-path", fakeEmacsclient, "(+ 1 2)"]);

  assert.equal(result.status, 0);
  assert.equal(result.json.tool, "emacs_eval");
  assert.equal(result.json.expressionIncluded, true);
  assert.equal(result.json.value, "3");
});

test("CLI emits nonzero JSON errors on validation failure", async () => {
  const outsideWorkspace = path.join(os.tmpdir(), "claw-emacs-outside.txt");
  const result = await runCli(["open", outsideWorkspace, "--emacsclient-path", fakeEmacsclient]);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /path must be inside workspace or allowedRoots/);
});

test("CLI path does not import the OpenClaw plugin SDK", () => {
  const cliSource = fs.readFileSync(cliPath, "utf8");
  const coreSource = fs.readFileSync(path.join(rootDir, "dist", "core.js"), "utf8");

  assert.doesNotMatch(cliSource, /openclaw\/plugin-sdk/);
  assert.doesNotMatch(coreSource, /openclaw\/plugin-sdk/);
});

test("shared core executes read with fake emacsclient", async () => {
  const { executeEmacsTool } = await import(coreUrl);
  const payload = await executeEmacsTool(
    "emacs_read",
    { buffer: "*core*", view: "region", maxChars: 700 },
    { emacsclientPath: fakeEmacsclient },
    { workspaceDir: rootDir },
  );

  assert.equal(payload.tool, "emacs_read");
  assert.equal(payload.buffer, "*core*");
  assert.equal(payload.requestedView, "region");
  assert.equal(payload.maxChars, 700);
});

test("shared core executes list with fake emacsclient", async () => {
  const { executeEmacsTool } = await import(coreUrl);
  const payload = await executeEmacsTool(
    "emacs_list",
    { includeFrames: false, includeWindows: false },
    { emacsclientPath: fakeEmacsclient },
    { workspaceDir: rootDir },
  );

  assert.equal(payload.tool, "emacs_list");
  assert.equal(payload.includeFrames, false);
  assert.equal(payload.includeWindows, false);
});
