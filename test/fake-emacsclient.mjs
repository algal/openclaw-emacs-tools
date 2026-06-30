#!/usr/bin/env node
import fs from "node:fs";

if (process.env.FAKE_EMACSCLIENT_FAIL) {
  fs.writeSync(2, "can't find socket\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const evalIndex = args.indexOf("--eval");
const expression = evalIndex >= 0 ? args[evalIndex + 1] ?? "" : "";
const toolNames = [
  "emacs_list",
  "emacs_read",
  "emacs_open",
  "emacs_insert",
  "emacs_edit",
  "emacs_eval",
];
const tool = toolNames.find((name) => expression.includes(`"${name}"`)) ?? "unknown";
const decodedStrings = [...expression.matchAll(/base64-decode-string "([^"]+)"/g)].map((match) =>
  Buffer.from(match[1], "base64").toString("utf8"),
);

function numberAfter(name) {
  const match = expression.match(new RegExp(`\\(${name} ([0-9]+)\\)`));
  return match ? Number(match[1]) : undefined;
}

function boolAfter(name) {
  if (expression.includes(`(${name} t)`)) {
    return true;
  }
  if (expression.includes(`(${name} nil)`)) {
    return false;
  }
  return undefined;
}

const payload = {
  ok: true,
  fake: true,
  tool,
  argv: args,
};

if (process.env.FAKE_EMACSCLIENT_LOG) {
  fs.appendFileSync(
    process.env.FAKE_EMACSCLIENT_LOG,
    `${JSON.stringify({ args, tool, expressionLength: expression.length })}\n`,
  );
}

if (tool === "emacs_list") {
  Object.assign(payload, {
    count: 1,
    includeFrames: boolAfter("include-frames"),
    includeWindows: boolAfter("include-windows"),
    buffers: [{ name: "*scratch*", file: null, modified: false, mode: "lisp-interaction-mode" }],
    frames: [],
    windows: [],
  });
} else if (tool === "emacs_read") {
  Object.assign(payload, {
    buffer: decodedStrings[0] ?? "*active*",
    requestedView: decodedStrings[1] ?? "visible",
    maxChars: numberAfter("limit"),
    visibleText: "fake visible text",
    visibleTextLength: 17,
  });
} else if (tool === "emacs_open") {
  Object.assign(payload, {
    file: decodedStrings[0],
    line: numberAfter("line-value"),
    column: numberAfter("column-value"),
    focused: boolAfter("focus-window"),
  });
} else if (tool === "emacs_insert") {
  Object.assign(payload, {
    text: decodedStrings[0],
    buffer: decodedStrings[1],
    at: decodedStrings[2],
    line: numberAfter("at-line"),
    column: numberAfter("at-column"),
    undoBoundary: boolAfter("with-undo-boundary"),
  });
} else if (tool === "emacs_edit") {
  Object.assign(payload, {
    buffer: decodedStrings[0],
    old_string: decodedStrings[1],
    new_string: decodedStrings[2],
  });
} else if (tool === "emacs_eval") {
  Object.assign(payload, {
    expressionIncluded: expression.includes("(+ 1 2)"),
    value: "3",
    valueType: "integer",
    stdout: "",
    messages: "OpenClaw emacs_eval: evaluating expression\n",
    stderr: "",
    hadError: false,
  });
}

fs.writeSync(1, `${JSON.stringify(payload)}\n`);
