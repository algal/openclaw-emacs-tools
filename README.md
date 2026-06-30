# Claw Emacs

OpenClaw plugin and CLI that give agents or shell scripts direct access to a running Emacs daemon via `emacsclient`. Read buffers, make edits, open files, and evaluate arbitrary Emacs Lisp through the same command surface.

## Tools

| Tool           | Description                                                                           |
|----------------|---------------------------------------------------------------------------------------|
| `emacs_read`   | Read text from a buffer. Omit `buffer` to read the user's active window.              |
| `emacs_edit`   | Find-and-replace in a buffer using normalized `old_string`/`new_string` params.      |
| `emacs_insert` | Insert text at point/bob/eob/line_column. Omit `buffer` for the active buffer.        |
| `emacs_open`   | Open a file in the user's active window, with optional line/column positioning.       |
| `emacs_eval`   | Evaluate arbitrary Emacs Lisp. Returns the expression's value or `princ` output.      |
| `emacs_list`   | List all buffers, frames, and windows. Discovery tool.                                |

### `emacs_read`

```
emacs_read(active?, buffer?, view?, maxChars?)
```

- `active` — Explicitly read the user's currently active window. Mutually exclusive with `buffer`.
- `buffer` — Buffer name. If omitted, reads the user's currently active window.
- `view` — `"visible"` (default), `"around_point"`, or `"region"`.
- `maxChars` — Truncation limit.

Returns buffer contents with point/line/column metadata.

### `emacs_edit`

```
emacs_edit(buffer, old_string, new_string)
```

Surgical find-and-replace. `old_string` and `new_string` follow OpenClaw-style
parameter normalization, so leading/trailing parameter whitespace is trimmed before
matching/replacement. Errors if no match or multiple matches found. Supports undo.

### `emacs_insert`

```
emacs_insert(text, buffer?, at?)
```

- `buffer` — Target buffer. If omitted, inserts into the user's active buffer.
- `at` — `"point"` (default), `"bob"`, `"eob"`, or `"line_column"` (requires `line`).

### `emacs_open`

```
emacs_open(path, line?, column?, focus?)
```

Opens a file in the active window. `path` must be within the workspace or `allowedRoots`.

### `emacs_eval`

```
emacs_eval(expression)
```

Evaluate any Emacs Lisp expression and return structured capture:
- `value` — Printed representation of the returned Lisp value.
- `valueType` — Lisp type of the returned value.
- `stdout` — Output written via `princ`/`print`/`standard-output`.
- `messages` — Text emitted via `message`.
- `stderr` — Captured error channel text and error message (if evaluation failed).

### `emacs_list`

```
emacs_list(includeFrames?, includeWindows?)
```

Returns all buffers (name, file, mode, modified status) plus optional frame/window inventories.

## Install

Build the TypeScript outputs:

```bash
npm run build
```

The build marks `dist/cli.js` executable, so npm-linked and symlinked `claw-emacs`
entrypoints can run through their shebang.

For CLI use from this checkout:

```bash
npm link
claw-emacs --help
```

For OpenClaw plugin use:

```bash
openclaw plugins install ~/path/to/claw-emacs
```

Then enable for your agent:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        tools: {
          alsoAllow: ["emacs-tools"]
        }
      }
    ]
  }
}
```

## Config

In `openclaw.json` under `plugins.entries`:

```json5
{
  "emacs-tools": {
    enabled: true,
    config: {
      emacsclientPath: "emacsclient",  // default
      socketName: "server",            // default
      timeoutSeconds: 5,               // default
      maxReadChars: 24000,             // default
      allowOpenOutsideWorkspace: false, // default
      allowedRoots: ["/home/user/projects"],
      disableInSandbox: true           // default
    }
  }
}
```

## CLI

The package exposes one binary:

```bash
claw-emacs <command> [flags]
```

Commands match the OpenClaw tools:

| CLI command | Plugin alias   | Description                                      |
|-------------|----------------|--------------------------------------------------|
| `list`      | `emacs_list`   | List buffers, frames, and windows.               |
| `read`      | `emacs_read`   | Read text from a buffer or active window.        |
| `open`      | `emacs_open`   | Open a file in the active Emacs window.          |
| `insert`    | `emacs_insert` | Insert text at point/bob/eob/line_column.        |
| `edit`      | `emacs_edit`   | Replace exact text in a buffer.                  |
| `eval`      | `emacs_eval`   | Evaluate Emacs Lisp with structured capture.     |

Global flags mirror plugin config:

```bash
--emacsclient-path PATH
--socket-name NAME
--server-file PATH
--timeout-seconds N
--max-read-chars N
--workspace-dir DIR
--allow-open-outside-workspace
--allowed-root DIR
--json-args '{"buffer":"*scratch*"}'
--pretty
```

Examples:

```bash
claw-emacs list
claw-emacs read --active --view visible
claw-emacs read --buffer '*scratch*' --view visible --max-chars 12000
claw-emacs open README.md --line 12 --column 0
claw-emacs insert --text 'hello' --buffer '*scratch*' --at eob
claw-emacs edit --buffer '*scratch*' --old-string 'hello' --new-string 'hello world'
claw-emacs eval --expression '(+ 1 2)'
```

The CLI writes JSON to stdout on success and failure. Failures exit nonzero and use:

```json
{"ok":false,"error":"...","status":400,"name":"ToolInputError"}
```

Runtime failures may omit `status`/`name`; validation failures include the structured
400 shape above.

Monitoring-friendly examples:

```bash
claw-emacs list | jq -c '{ok, count, buffers: [.buffers[].name]}'
claw-emacs read --active --view visible | jq -e '.ok == true and (.visibleTextLength >= 0)'
claw-emacs eval --expression '(progn (princ "alive") t)' | jq -e '.ok == true and .stdout == "alive"'
```

For shell checks that preserve the JSON error body:

```bash
if ! claw-emacs list > /tmp/claw-emacs-status.json; then
  jq -c '{ok, status, name, error}' /tmp/claw-emacs-status.json
  exit 1
fi
```

## Requirements

- A running Emacs server (`emacs --daemon` or `M-x server-start`)
- `emacsclient` on PATH (or configured via `emacsclientPath`)

## Security

- All tools are registered as **optional** and must be explicitly allowlisted.
- `emacs_open` is workspace-scoped by default. Use `allowedRoots` to grant access to additional directories.
- `emacs_eval` can execute arbitrary Emacs Lisp — treat it as you would shell access.
- All commands use `spawn` (no shell interpolation), with bounded output and timeouts.
