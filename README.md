# Emacs Tools Plugin for OpenClaw

OpenClaw plugin that gives your agent direct access to a running Emacs daemon via `emacsclient`. Read buffers, make edits, open files, and evaluate arbitrary Emacs Lisp — all through clean tool interfaces designed to align with standard LLM tool-use patterns.

## Tools

| Tool           | Description                                                                           |
|----------------|---------------------------------------------------------------------------------------|
| `emacs_read`   | Read text from a buffer. Omit `buffer` to read the user's active window.              |
| `emacs_edit`   | Find-and-replace in a buffer. Exact match on `old_string`, replace with `new_string`. |
| `emacs_insert` | Insert text at point/bob/eob/line_column. Omit `buffer` for the active buffer.        |
| `emacs_open`   | Open a file in the user's active window, with optional line/column positioning.       |
| `emacs_eval`   | Evaluate arbitrary Emacs Lisp. Returns the expression's value or `princ` output.      |
| `emacs_list`   | List all buffers, frames, and windows. Discovery tool.                                |

### `emacs_read`

```
emacs_read(buffer?, view?, maxChars?)
```

- `buffer` — Buffer name. If omitted, reads the user's currently active window.
- `view` — `"visible"` (default), `"around_point"`, or `"region"`.
- `maxChars` — Truncation limit.

Returns buffer contents with point/line/column metadata.

### `emacs_edit`

```
emacs_edit(buffer, old_string, new_string)
```

Surgical find-and-replace. `old_string` must match exactly (including whitespace). Errors if no match or multiple matches found. Supports undo.

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

Evaluate any Emacs Lisp expression. Use `princ` to return string output. This is the escape hatch for anything the other tools don't cover.

### `emacs_list`

```
emacs_list(includeFrames?, includeWindows?)
```

Returns all buffers (name, file, mode, modified status) plus optional frame/window inventories.

## Install

```bash
openclaw plugins install ~/path/to/emacs-tools
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

## Requirements

- A running Emacs server (`emacs --daemon` or `M-x server-start`)
- `emacsclient` on PATH (or configured via `emacsclientPath`)

## Security

- All tools are registered as **optional** and must be explicitly allowlisted.
- `emacs_open` is workspace-scoped by default. Use `allowedRoots` to grant access to additional directories.
- `emacs_eval` can execute arbitrary Emacs Lisp — treat it as you would shell access.
- All commands use `spawn` (no shell interpolation), with bounded output and timeouts.
