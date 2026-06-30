#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  executeEmacsTool,
  type EmacsToolContext,
  type EmacsToolName,
  type EmacsToolsConfigInput,
} from "./core.js";

const MAX_CLI_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 4_000;

type FlagTarget = "config" | "context" | "params" | "meta";
type FlagType = "boolean" | "number" | "string";

type FlagSpec = {
  key: string;
  target: FlagTarget;
  type: FlagType;
  repeat?: boolean;
};

type ParsedFlags = {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  params: Record<string, unknown>;
  meta: Record<string, unknown>;
  positionals: string[];
};

type CommandSpec = {
  toolName: EmacsToolName;
  usage: string;
  flags: Record<string, FlagSpec>;
  applyPositionals?: (params: Record<string, unknown>, positionals: string[]) => void;
};

type CliIo = {
  writeStdout?: (text: string) => void;
};

const COMMON_FLAGS: Record<string, FlagSpec> = {
  "emacsclient-path": { target: "config", key: "emacsclientPath", type: "string" },
  emacsclient: { target: "config", key: "emacsclientPath", type: "string" },
  "socket-name": { target: "config", key: "socketName", type: "string" },
  socket: { target: "config", key: "socketName", type: "string" },
  "server-file": { target: "config", key: "serverFile", type: "string" },
  "timeout-seconds": { target: "config", key: "timeoutSeconds", type: "number" },
  timeout: { target: "config", key: "timeoutSeconds", type: "number" },
  "max-read-chars": { target: "config", key: "maxReadChars", type: "number" },
  "workspace-dir": { target: "context", key: "workspaceDir", type: "string" },
  "allow-open-outside-workspace": {
    target: "config",
    key: "allowOpenOutsideWorkspace",
    type: "boolean",
  },
  "allowed-root": { target: "config", key: "allowedRoots", type: "string", repeat: true },
  "disable-in-sandbox": { target: "config", key: "disableInSandbox", type: "boolean" },
  sandboxed: { target: "context", key: "sandboxed", type: "boolean" },
  "json-args": { target: "meta", key: "jsonArgs", type: "string" },
  pretty: { target: "meta", key: "pretty", type: "boolean" },
  help: { target: "meta", key: "help", type: "boolean" },
};

const COMMAND_SPECS: Record<string, CommandSpec> = {
  list: {
    toolName: "emacs_list",
    usage: "claw-emacs list [--include-frames/--no-include-frames] [--include-windows/--no-include-windows]",
    flags: {
      "include-frames": { target: "params", key: "includeFrames", type: "boolean" },
      includeFrames: { target: "params", key: "includeFrames", type: "boolean" },
      "include-windows": { target: "params", key: "includeWindows", type: "boolean" },
      includeWindows: { target: "params", key: "includeWindows", type: "boolean" },
    },
  },
  read: {
    toolName: "emacs_read",
    usage: "claw-emacs read [--buffer NAME] [--view visible|around_point|region] [--max-chars N]",
    flags: {
      buffer: { target: "params", key: "buffer", type: "string" },
      view: { target: "params", key: "view", type: "string" },
      "max-chars": { target: "params", key: "maxChars", type: "number" },
      maxChars: { target: "params", key: "maxChars", type: "number" },
      max_chars: { target: "params", key: "maxChars", type: "number" },
    },
    applyPositionals: (params, positionals) => {
      if (params.buffer === undefined && positionals.length === 1) {
        params.buffer = positionals[0];
      }
    },
  },
  open: {
    toolName: "emacs_open",
    usage: "claw-emacs open PATH [--line N] [--column N] [--focus/--no-focus]",
    flags: {
      path: { target: "params", key: "path", type: "string" },
      line: { target: "params", key: "line", type: "number" },
      column: { target: "params", key: "column", type: "number" },
      focus: { target: "params", key: "focus", type: "boolean" },
    },
    applyPositionals: (params, positionals) => {
      if (params.path === undefined && positionals.length >= 1) {
        params.path = positionals[0];
      }
    },
  },
  insert: {
    toolName: "emacs_insert",
    usage:
      "claw-emacs insert --text TEXT [--buffer NAME] [--at point|bob|eob|line_column] [--line N] [--column N]",
    flags: {
      text: { target: "params", key: "text", type: "string" },
      buffer: { target: "params", key: "buffer", type: "string" },
      at: { target: "params", key: "at", type: "string" },
      line: { target: "params", key: "line", type: "number" },
      column: { target: "params", key: "column", type: "number" },
      "undo-boundary": { target: "params", key: "undoBoundary", type: "boolean" },
      undoBoundary: { target: "params", key: "undoBoundary", type: "boolean" },
      undo_boundary: { target: "params", key: "undoBoundary", type: "boolean" },
    },
    applyPositionals: (params, positionals) => {
      if (params.text === undefined && positionals.length >= 1) {
        params.text = positionals.join(" ");
      }
    },
  },
  edit: {
    toolName: "emacs_edit",
    usage: "claw-emacs edit --buffer NAME --old-string OLD --new-string NEW",
    flags: {
      buffer: { target: "params", key: "buffer", type: "string" },
      "old-string": { target: "params", key: "old_string", type: "string" },
      old_string: { target: "params", key: "old_string", type: "string" },
      "new-string": { target: "params", key: "new_string", type: "string" },
      new_string: { target: "params", key: "new_string", type: "string" },
    },
  },
  eval: {
    toolName: "emacs_eval",
    usage: "claw-emacs eval --expression EXPR",
    flags: {
      expression: { target: "params", key: "expression", type: "string" },
    },
    applyPositionals: (params, positionals) => {
      if (params.expression === undefined && positionals.length >= 1) {
        params.expression = positionals.join(" ");
      }
    },
  },
};

const COMMAND_ALIASES: Record<string, string> = {
  emacs_list: "list",
  emacs_read: "read",
  emacs_open: "open",
  emacs_insert: "insert",
  emacs_edit: "edit",
  emacs_eval: "eval",
};

const HELP = `Usage: claw-emacs [global flags] <command> [command flags]

Commands:
  list       List buffers, frames, and windows
  read       Read text from a buffer or the active window
  open       Open a file in Emacs
  insert     Insert text into a buffer
  edit       Replace exact text in a buffer
  eval       Evaluate Emacs Lisp

Plugin-name aliases are also accepted: emacs_list, emacs_read, emacs_open, emacs_insert, emacs_edit, emacs_eval.

Global flags:
  --emacsclient-path PATH       emacsclient executable, default emacsclient
  --socket-name NAME            emacsclient --socket-name
  --server-file PATH            emacsclient --server-file
  --timeout-seconds N           emacsclient timeout, default 5
  --max-read-chars N            default read limit, default 24000
  --workspace-dir DIR           workspace root for open path checks, default cwd
  --allow-open-outside-workspace
  --allowed-root DIR            extra allowed open root, repeatable
  --json-args JSON              plugin-style JSON params merged before explicit flags
  --pretty                      pretty-print JSON output
`;

function getCommandSpec(command: string): CommandSpec | undefined {
  return COMMAND_SPECS[COMMAND_ALIASES[command] ?? command];
}

function parseBooleanLiteral(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid boolean value: ${value}`);
}

function coerceValue(spec: FlagSpec, value: string): string | number | boolean {
  if (spec.type === "boolean") {
    return parseBooleanLiteral(value);
  }
  if (spec.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${spec.key} must be a number`);
    }
    return parsed;
  }
  return value;
}

function setParsedValue(parsed: ParsedFlags, spec: FlagSpec, value: unknown): void {
  const target = parsed[spec.target];
  if (spec.repeat) {
    const existing = target[spec.key];
    target[spec.key] = Array.isArray(existing) ? [...existing, value] : [value];
    return;
  }
  target[spec.key] = value;
}

function parseTokens(tokens: string[], specs: Record<string, FlagSpec>): ParsedFlags {
  const parsed: ParsedFlags = {
    config: {},
    context: {},
    params: {},
    meta: {},
    positionals: [],
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      parsed.positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    const rawName = eqIndex >= 0 ? withoutPrefix.slice(0, eqIndex) : withoutPrefix;
    const inlineValue = eqIndex >= 0 ? withoutPrefix.slice(eqIndex + 1) : undefined;
    const negated = rawName.startsWith("no-");
    const name = negated ? rawName.slice(3) : rawName;
    const spec = specs[name];

    if (!spec) {
      throw new Error(`unknown flag: --${rawName}`);
    }
    if (negated && spec.type !== "boolean") {
      throw new Error(`--no-${name} is only valid for boolean flags`);
    }

    if (spec.type === "boolean") {
      const value =
        inlineValue === undefined ? !negated : negated ? !parseBooleanLiteral(inlineValue) : parseBooleanLiteral(inlineValue);
      setParsedValue(parsed, spec, value);
      continue;
    }

    const nextValue = inlineValue ?? tokens[i + 1];
    if (nextValue === undefined || nextValue.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    if (inlineValue === undefined) {
      i += 1;
    }
    setParsedValue(parsed, spec, coerceValue(spec, nextValue));
  }

  return parsed;
}

function splitInvocation(argv: string[]): { command?: string; leadingGlobals: string[]; commandArgs: string[] } {
  const leadingGlobals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      return {
        command: token,
        leadingGlobals,
        commandArgs: argv.slice(i + 1),
      };
    }

    const withoutPrefix = token.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    const rawName = eqIndex >= 0 ? withoutPrefix.slice(0, eqIndex) : withoutPrefix;
    const name = rawName.startsWith("no-") ? rawName.slice(3) : rawName;
    const spec = COMMON_FLAGS[name];
    if (!spec) {
      return {
        command: undefined,
        leadingGlobals: argv,
        commandArgs: [],
      };
    }

    leadingGlobals.push(token);
    if (spec.type !== "boolean" && eqIndex < 0) {
      if (argv[i + 1] === undefined) {
        return {
          command: undefined,
          leadingGlobals: argv,
          commandArgs: [],
        };
      }
      leadingGlobals.push(argv[i + 1]);
      i += 1;
    }
  }

  return { leadingGlobals, commandArgs: [] };
}

function parseInvocation(argv: string[]): {
  toolName: EmacsToolName;
  params: Record<string, unknown>;
  config: EmacsToolsConfigInput;
  context: EmacsToolContext;
  pretty: boolean;
} {
  const { command, leadingGlobals, commandArgs } = splitInvocation(argv);
  if (!command) {
    throw new Error("command required");
  }

  const commandSpec = getCommandSpec(command);
  if (!commandSpec) {
    throw new Error(`unknown command: ${command}`);
  }

  const parsed = parseTokens([...leadingGlobals, ...commandArgs], {
    ...COMMON_FLAGS,
    ...commandSpec.flags,
  });

  if (parsed.meta.help) {
    throw new HelpRequested(commandSpec.usage);
  }

  let params = parsed.params;
  if (typeof parsed.meta.jsonArgs === "string") {
    const jsonArgs = JSON.parse(parsed.meta.jsonArgs);
    if (!jsonArgs || typeof jsonArgs !== "object" || Array.isArray(jsonArgs)) {
      throw new Error("--json-args must be a JSON object");
    }
    params = { ...(jsonArgs as Record<string, unknown>), ...params };
  }

  commandSpec.applyPositionals?.(params, parsed.positionals);

  return {
    toolName: commandSpec.toolName,
    params,
    config: parsed.config,
    context: parsed.context,
    pretty: Boolean(parsed.meta.pretty),
  };
}

class HelpRequested extends Error {
  constructor(readonly commandUsage?: string) {
    super("help requested");
  }
}

function truncateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_MESSAGE_CHARS
    ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}...`
    : message;
}

function jsonLine(payload: unknown, pretty: boolean): { text: string; ok: boolean } {
  const text = `${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_CLI_JSON_BYTES) {
    return { text, ok: true };
  }

  return {
    text: `${JSON.stringify({
      ok: false,
      error: "CLI JSON output exceeded limit",
      limitBytes: MAX_CLI_JSON_BYTES,
      actualBytes: bytes,
    })}\n`,
    ok: false,
  };
}

function writeJson(payload: unknown, pretty: boolean, io: Required<CliIo>): boolean {
  const result = jsonLine(payload, pretty);
  io.writeStdout(result.text);
  return result.ok;
}

export async function runCli(argv = process.argv.slice(2), ioInput: CliIo = {}): Promise<number> {
  const io: Required<CliIo> = {
    writeStdout: ioInput.writeStdout ?? ((text) => process.stdout.write(text)),
  };

  try {
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
      io.writeStdout(HELP);
      return 0;
    }

    const invocation = parseInvocation(argv);
    const payload = await executeEmacsTool(
      invocation.toolName,
      invocation.params,
      invocation.config,
      invocation.context,
    );

    return writeJson(payload, invocation.pretty, io) ? 0 : 1;
  } catch (error) {
    if (error instanceof HelpRequested) {
      io.writeStdout(`${error.commandUsage ?? HELP}\n`);
      return 0;
    }

    writeJson(
      {
        ok: false,
        error: truncateErrorMessage(error),
      },
      false,
      io,
    );
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCli();
}
