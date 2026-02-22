import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";

type EmacsToolsPluginConfig = {
  emacsclientPath: string;
  socketName?: string;
  serverFile?: string;
  timeoutSeconds: number;
  maxReadChars: number;
  allowOpenOutsideWorkspace: boolean;
  allowedRoots: string[];
  disableInSandbox: boolean;
};

type EmacsRunConfig = {
  emacsclientPath: string;
  socketName?: string;
  serverFile?: string;
  timeoutSeconds: number;
};

type InsertPlacement = {
  at: "point" | "bob" | "eob" | "line_column";
  line?: number;
  column?: number;
  undoBoundary: boolean;
};

const DEFAULT_CONFIG: EmacsToolsPluginConfig = {
  emacsclientPath: "emacsclient",
  timeoutSeconds: 5,
  maxReadChars: 24_000,
  allowOpenOutsideWorkspace: false,
  allowedRoots: [],
  disableInSandbox: true,
};

const MAX_STDIO_BYTES = 2 * 1024 * 1024;
const MAX_CURRENT_CHARS_HARD_LIMIT = 200_000;
const MIN_CURRENT_CHARS_HARD_LIMIT = 256;

const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    includeFrames: { type: "boolean" },
    includeWindows: { type: "boolean" },
  },
} as const;

const READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    buffer: { type: "string", description: "Buffer name to read. If omitted, reads the user's currently active window." },
    view: {
      type: "string",
      enum: ["visible", "around_point", "region"],
      description: "What slice of text to return. 'visible' = what's on screen (default), 'around_point' = text around cursor, 'region' = active selection.",
    },
    maxChars: {
      type: "number",
      minimum: MIN_CURRENT_CHARS_HARD_LIMIT,
      maximum: MAX_CURRENT_CHARS_HARD_LIMIT,
    },
  },
} as const;

const OPEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    line: { type: "number", minimum: 1 },
    column: { type: "number", minimum: 0 },
    focus: { type: "boolean" },
  },
  required: ["path"],
} as const;

const INSERT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    buffer: { type: "string", description: "Buffer name to insert into. If omitted, inserts into the user's currently active buffer." },
    at: {
      type: "string",
      enum: ["point", "bob", "eob", "line_column"],
    },
    line: { type: "number", minimum: 1 },
    column: { type: "number", minimum: 0 },
    undoBoundary: { type: "boolean" },
  },
  required: ["text"],
} as const;

const EVAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    expression: { type: "string", description: "Emacs Lisp expression to evaluate." },
  },
  required: ["expression"],
} as const;

const EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    buffer: { type: "string", description: "Buffer name to edit. Required." },
    old_string: { type: "string", description: "Exact text to find and replace (must match exactly, including whitespace)." },
    new_string: { type: "string", description: "New text to replace the old text with." },
  },
  required: ["buffer", "old_string", "new_string"],
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeForPathCompare(input: string): string {
  const normalized = path.normalize(input);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeForPathCompare(candidatePath);
  const root = normalizeForPathCompare(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function expandUserHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolveAbsolutePath(input: string, baseDir?: string): string {
  const expanded = expandUserHome(input.trim());
  if (!expanded) {
    return "";
  }
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(baseDir ?? process.cwd(), expanded);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseOptionalInt(
  params: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined {
  const value = readNumberParam(params, key, { integer: true });
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(min, Math.floor(value));
}

function parseCurrentView(value: unknown): "visible" | "around_point" | "region" {
  if (typeof value !== "string") {
    return "visible";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "around_point" || normalized === "around-point" || normalized === "point") {
    return "around_point";
  }
  if (normalized === "region") {
    return "region";
  }
  return "visible";
}

function parseInsertPlacement(params: Record<string, unknown>): InsertPlacement {
  const atRaw = parseString(params.at)?.toLowerCase();
  const line = parseOptionalInt(params, "line", 1);
  const column = parseOptionalInt(params, "column", 0) ?? 0;
  const undoBoundary = parseBoolean(params.undoBoundary, true);

  let at: InsertPlacement["at"] = "point";
  if (atRaw === "bob" || atRaw === "beginning") {
    at = "bob";
  } else if (atRaw === "eob" || atRaw === "end") {
    at = "eob";
  } else if (atRaw === "line_column" || atRaw === "line-column" || atRaw === "line") {
    at = "line_column";
  }

  if ((at === "line_column" || line !== undefined) && line === undefined) {
    throw new Error("line required when at=line_column");
  }

  if (line !== undefined) {
    at = "line_column";
  }

  return {
    at,
    line,
    column,
    undoBoundary,
  };
}

function resolvePluginConfig(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): EmacsToolsPluginConfig {
  const raw = asRecord(api.pluginConfig);
  const workspaceDir = parseString(ctx.workspaceDir)
    ? path.resolve(String(ctx.workspaceDir))
    : undefined;

  const allowedRootsRaw = Array.isArray(raw.allowedRoots)
    ? raw.allowedRoots.filter((entry) => typeof entry === "string")
    : [];

  const allowedRoots = allowedRootsRaw
    .map((entry) => resolveAbsolutePath(entry, workspaceDir))
    .filter(Boolean);

  return {
    emacsclientPath: parseString(raw.emacsclientPath) ?? DEFAULT_CONFIG.emacsclientPath,
    socketName: parseString(raw.socketName),
    serverFile: parseString(raw.serverFile),
    timeoutSeconds: parseNumber(raw.timeoutSeconds, DEFAULT_CONFIG.timeoutSeconds, 1, 120),
    maxReadChars: parseNumber(
      raw.maxReadChars,
      DEFAULT_CONFIG.maxReadChars,
      MIN_CURRENT_CHARS_HARD_LIMIT,
      MAX_CURRENT_CHARS_HARD_LIMIT,
    ),
    allowOpenOutsideWorkspace: parseBoolean(
      raw.allowOpenOutsideWorkspace,
      DEFAULT_CONFIG.allowOpenOutsideWorkspace,
    ),
    allowedRoots,
    disableInSandbox: parseBoolean(raw.disableInSandbox, DEFAULT_CONFIG.disableInSandbox),
  };
}

function resolveRunConfig(cfg: EmacsToolsPluginConfig): EmacsRunConfig {
  return {
    emacsclientPath: cfg.emacsclientPath,
    socketName: cfg.socketName,
    serverFile: cfg.serverFile,
    timeoutSeconds: cfg.timeoutSeconds,
  };
}

function toElispBase64DecodeExpr(value: string): string {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `(decode-coding-string (base64-decode-string "${b64}") 'utf-8)`;
}

function toElispStringOrNil(value: string | undefined): string {
  return value ? toElispBase64DecodeExpr(value) : "nil";
}

function toElispNumberOrNil(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.floor(value)) : "nil";
}

function toElispBool(value: boolean): string {
  return value ? "t" : "nil";
}

function summarizeCommandFailure(command: string, stderr: string, stdout: string): string {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  if (
    combined.includes("can't find socket") ||
    combined.includes("no socket") ||
    combined.includes("no running emacs") ||
    combined.includes("connection refused")
  ) {
    return `${command} could not connect to a running Emacs server. Start Emacs daemon (e.g. emacs --daemon) and ensure socket/server-file settings match.`;
  }
  const detail = (stderr.trim() || stdout.trim() || "unknown error").slice(0, 600);
  return `${command} failed: ${detail}`;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function runEmacsEval(runCfg: EmacsRunConfig, elispExpression: string): Promise<unknown> {
  const args: string[] = [];

  if (runCfg.socketName) {
    args.push("--socket-name", runCfg.socketName);
  }
  if (runCfg.serverFile) {
    args.push("--server-file", runCfg.serverFile);
  }

  args.push("--timeout", String(runCfg.timeoutSeconds));
  args.push("--eval", elispExpression);

  const timeoutMs = Math.max(1_000, runCfg.timeoutSeconds * 1_000 + 1_000);

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(runCfg.emacsclientPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const addChunk = (target: "stdout" | "stderr", chunk: unknown) => {
        const text = String(chunk);
        bytes += Buffer.byteLength(text, "utf8");
        if (bytes > MAX_STDIO_BYTES) {
          try {
            child.kill("SIGKILL");
          } finally {
            finish(() => reject(new Error("emacsclient output exceeded limit")));
          }
          return;
        }
        if (target === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => addChunk("stdout", chunk));
      child.stderr?.on("data", (chunk) => addChunk("stderr", chunk));

      child.once("error", (err) => {
        finish(() => reject(new Error(`failed to run emacsclient: ${String(err)}`)));
      });

      child.once("close", (code) => {
        finish(() => resolve({ code, stdout, stderr }));
      });

      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } finally {
          finish(() => reject(new Error("emacsclient execution timed out")));
        }
      }, timeoutMs);
    },
  );

  if (result.code !== 0) {
    throw new Error(summarizeCommandFailure("emacsclient", result.stderr, result.stdout));
  }

  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return { ok: true };
  }

  const parsed = tryParseJson(trimmed);
  if (parsed !== undefined) {
    // emacsclient prints string return values as escaped strings; parse nested JSON once more.
    if (typeof parsed === "string") {
      const nestedSource = parsed.trim();
      if (nestedSource.startsWith("{") || nestedSource.startsWith("[")) {
        const nested = tryParseJson(nestedSource);
        if (nested !== undefined) {
          return nested;
        }
      }
    }
    return parsed;
  }

  return {
    ok: true,
    raw: trimmed,
  };
}

function assertOpenPathAllowed(
  requestedPath: string,
  ctx: OpenClawPluginToolContext,
  cfg: EmacsToolsPluginConfig,
): string {
  const workspaceDir = parseString(ctx.workspaceDir)
    ? path.resolve(String(ctx.workspaceDir))
    : undefined;
  const absolutePath = resolveAbsolutePath(requestedPath, workspaceDir);
  if (!absolutePath) {
    throw new Error("path required");
  }

  const roots: string[] = [workspaceDir ?? process.cwd(), ...cfg.allowedRoots];
  const allowedByRoot = roots.some((root) => isWithinRoot(absolutePath, root));

  if (!cfg.allowOpenOutsideWorkspace && !allowedByRoot) {
    const defaultRoot = workspaceDir ?? process.cwd();
    throw new Error(
      `path must be inside workspace or allowedRoots (resolved: ${absolutePath}, workspace: ${defaultRoot})`,
    );
  }

  return absolutePath;
}

/**
 * Elisp prelude that defines helpers for user-active tracking,
 * window/frame id formatting, and buffer/window resolution.
 * Injected at the top of tool expressions that need window awareness.
 * Designed to be idempotent (guarded by fboundp).
 */
const ELISP_HELPERS = `
  (defvar openclaw-last-user-window nil)
  (defvar openclaw-last-user-frame nil)
  (unless (fboundp 'openclaw--track-user-window)
    (defun openclaw--track-user-window ()
      (setq openclaw-last-user-window (selected-window))
      (setq openclaw-last-user-frame (selected-frame))))
  (unless (memq #'openclaw--track-user-window post-command-hook)
    (add-hook 'post-command-hook #'openclaw--track-user-window))
  (unless (fboundp 'openclaw--frame-id)
    (defun openclaw--frame-id (f) (format "%s" f)))
  (unless (fboundp 'openclaw--window-id)
    (defun openclaw--window-id (w) (format "%s" w)))
  (unless (fboundp 'openclaw--window-tty)
    (defun openclaw--window-tty (w)
      (let ((term (frame-terminal (window-frame w))))
        (when term (terminal-name term)))))
  (unless (fboundp 'openclaw--user-active-window)
    (defun openclaw--user-active-window ()
      (if (and openclaw-last-user-window (window-live-p openclaw-last-user-window))
          openclaw-last-user-window
        (selected-window))))
  (unless (fboundp 'openclaw--emit-json-result)
    (defun openclaw--emit-json-result (tool summary payload)
      (require 'json)
      (message "OpenClaw %s: %s" tool summary)
      (json-encode payload)))
`.trim();

function createListTool(runCfg: EmacsRunConfig): AnyAgentTool {
  return {
    name: "emacs_list",
    label: "Emacs List",
    description:
      "List buffers and optionally frames/windows, including stable ids for deterministic targeting.",
    parameters: LIST_SCHEMA,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = asRecord(args);
      const includeFrames = parseBoolean(params.includeFrames, true);
      const includeWindows = parseBoolean(params.includeWindows, true);

      const expr = `
(progn
  ${ELISP_HELPERS}
  (let* ((include-frames ${toElispBool(includeFrames)})
         (include-windows ${toElispBool(includeWindows)})
         (buffers
          (mapcar
           (lambda (b)
             (with-current-buffer b
               (let ((file (buffer-file-name b)))
                 \`((name . ,(buffer-name b))
                   (file . ,file)
                   (modified . ,(if (buffer-modified-p b) t :json-false))
                   (mode . ,(symbol-name major-mode))))))
           (buffer-list)))
         (frames
          (if include-frames
              (mapcar
               (lambda (f)
                 (let* ((term (frame-terminal f))
                        (tty (when term (terminal-name term))))
                   \`((frameId . ,(openclaw--frame-id f))
                     (name . ,(frame-parameter f 'name))
                     (tty . ,tty)
                     (selected . ,(if (eq f (selected-frame)) t :json-false)))))
               (frame-list))
            []))
         (windows
          (if include-windows
              (apply #'append
                     (mapcar
                      (lambda (f)
                        (mapcar
                         (lambda (w)
                           (let* ((buf (window-buffer w))
                                  (pt (window-point w))
                                  (line (with-current-buffer buf
                                          (save-excursion
                                            (goto-char pt)
                                            (line-number-at-pos pt))))
                                  (col (with-current-buffer buf
                                         (save-excursion
                                           (goto-char pt)
                                           (current-column))))
                                  (start (window-start w))
                                  (end (window-end w t)))
                             \`((windowId . ,(openclaw--window-id w))
                               (frameId . ,(openclaw--frame-id (window-frame w)))
                               (tty . ,(openclaw--window-tty w))
                               (buffer . ,(buffer-name buf))
                               (selected . ,(if (eq w (selected-window)) t :json-false))
                               (point . ,pt)
                               (line . ,line)
                               (column . ,col)
                               (start . ,start)
                               (end . ,end))))
                         (window-list f 'no-minibuffer)))
                      (frame-list)))
            [])))
    (openclaw--emit-json-result
     "emacs_list"
     (format "buffers=%d frames=%d windows=%d"
             (length buffers) (length frames) (length windows))
     \`((ok . t)
       (count . ,(length buffers))
       (buffers . ,buffers)
       (frames . ,frames)
       (windows . ,windows)
       (userActiveWindowId . ,(when (window-live-p openclaw-last-user-window)
                                (openclaw--window-id openclaw-last-user-window)))))))
`.trim();

      const payload = await runEmacsEval(runCfg, expr);
      return jsonResult(payload);
    },
  };
}

function createReadTool(runCfg: EmacsRunConfig, cfg: EmacsToolsPluginConfig): AnyAgentTool {
  return {
    name: "emacs_read",
    label: "Emacs Read",
    description:
      "Read text from an Emacs buffer. If buffer is omitted, reads the user's currently active window. Returns buffer contents with point/line/column metadata.",
    parameters: READ_SCHEMA,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = asRecord(args);
      const bufferName = readStringParam(params, "buffer", { trim: true });
      const view = parseCurrentView(params.view);
      const requestedMaxChars = readNumberParam(params, "maxChars", { integer: true });
      const maxChars =
        typeof requestedMaxChars === "number"
          ? Math.max(
              MIN_CURRENT_CHARS_HARD_LIMIT,
              Math.min(MAX_CURRENT_CHARS_HARD_LIMIT, Math.floor(requestedMaxChars)),
            )
          : cfg.maxReadChars;

      const bufferExpr = bufferName ? toElispBase64DecodeExpr(bufferName) : "nil";

      const expr = `
(progn
  ${ELISP_HELPERS}
  (let* ((buffer-name-arg ${bufferExpr})
         (view-mode ${toElispStringOrNil(view)})
         (limit ${maxChars})
         ;; Resolve: if buffer given, use it; otherwise use user-active window
         (win (if buffer-name-arg
                 (let ((buf (get-buffer buffer-name-arg)))
                   (unless buf (error "buffer not found: %s" buffer-name-arg))
                   (or (get-buffer-window buf t) nil))
               (openclaw--user-active-window)))
         (buf (if buffer-name-arg
                  (get-buffer buffer-name-arg)
                (window-buffer win)))
         (point (if win (window-point win)
                  (with-current-buffer buf (point))))
         (line (with-current-buffer buf
                 (save-excursion (goto-char point) (line-number-at-pos point))))
         (column (with-current-buffer buf
                   (save-excursion (goto-char point) (current-column))))
         (region-active (with-current-buffer buf (and (bound-and-true-p mark-active) (mark))))
         (region-start (when region-active
                         (with-current-buffer buf (region-beginning))))
         (region-end (when region-active
                       (with-current-buffer buf (region-end))))
         (effective-view view-mode)
         (start nil)
         (end nil))
    (cond
     ((string= view-mode "region")
      (if region-active
          (setq start region-start end region-end effective-view "region")
        (setq effective-view "around_point")))
     ((string= view-mode "around_point")
      (setq start nil end nil effective-view "around_point"))
     (t
      (if win
          (setq start (window-start win)
                end (window-end win t)
                effective-view "visible")
        ;; No window: fall back to around_point for buffer-only reads
        (setq effective-view "around_point"))))

    (when (and (string= effective-view "around_point") (or (null start) (null end)))
      (let* ((half (max 1 (/ limit 2)))
             (min-pos (with-current-buffer buf (point-min)))
             (max-pos (with-current-buffer buf (point-max))))
        (setq start (max min-pos (- point half)))
        (setq end (min max-pos (+ point half)))))

    (let* ((raw (with-current-buffer buf (buffer-substring-no-properties start end)))
           (raw-len (length raw))
           (truncated (> raw-len limit))
           (visible (if truncated (substring raw 0 limit) raw)))
      (openclaw--emit-json-result
       "emacs_read"
       (format "buffer=%s view=%s chars=%d%s"
               (buffer-name buf)
               effective-view
               (length visible)
               (if truncated "+" ""))
       \`((ok . t)
         (requestedView . ,view-mode)
         (effectiveView . ,effective-view)
         (buffer . ,(buffer-name buf))
         (file . ,(with-current-buffer buf (buffer-file-name buf)))
         (windowId . ,(when win (openclaw--window-id win)))
         (frameId . ,(when win (openclaw--frame-id (window-frame win))))
         (tty . ,(when win (openclaw--window-tty win)))
         (point . ,point)
         (line . ,line)
         (column . ,column)
         (regionActive . ,(if region-active t :json-false))
         (regionStart . ,region-start)
         (regionEnd . ,region-end)
         (start . ,start)
         (end . ,end)
         (visibleText . ,visible)
         (visibleTextLength . ,(length visible))
         (totalSliceLength . ,raw-len)
         (truncated . ,(if truncated t :json-false)))))))
`.trim();

      const payload = await runEmacsEval(runCfg, expr);
      return jsonResult(payload);
    },
  };
}

function createOpenTool(
  runCfg: EmacsRunConfig,
  cfg: EmacsToolsPluginConfig,
  ctx: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "emacs_open",
    label: "Emacs Open",
    description:
      "Open a file and display it in a deterministic target window, with optional line/column positioning.",
    parameters: OPEN_SCHEMA,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = asRecord(args);
      const requestedPath = readStringParam(params, "path", { required: true, trim: true });
      const absolutePath = assertOpenPathAllowed(requestedPath, ctx, cfg);
      const line = parseOptionalInt(params, "line", 1);
      const column = parseOptionalInt(params, "column", 0);
      const focus = parseBoolean(params.focus, true);

      const expr = `
(progn
  ${ELISP_HELPERS}
  (let* ((target-path ${toElispStringOrNil(absolutePath)})
         (line-value ${toElispNumberOrNil(line)})
         (column-value ${toElispNumberOrNil(column)})
         (focus-window ${toElispBool(focus)})
         (win (openclaw--user-active-window))
         (buf (find-file-noselect target-path)))
    (unless (window-live-p win)
      (error "could not resolve target window"))
    (set-window-buffer win buf)
    (with-current-buffer buf
      (when line-value
        (goto-char (point-min))
        (forward-line (max 0 (1- line-value))))
      (when column-value
        (move-to-column column-value t))
      (set-window-point win (point))
      (when focus-window
        (select-window win))
      (let* ((frame (window-frame win))
             (point (window-point win))
             (line (save-excursion (goto-char point) (line-number-at-pos point)))
             (column (save-excursion (goto-char point) (current-column))))
        (openclaw--emit-json-result
         "emacs_open"
         (format "buffer=%s line=%d column=%d"
                 (buffer-name buf) line column)
         \`((ok . t)
           (buffer . ,(buffer-name buf))
           (file . ,(buffer-file-name buf))
           (windowId . ,(openclaw--window-id win))
           (frameId . ,(openclaw--frame-id frame))
           (tty . ,(openclaw--window-tty win))
           (point . ,point)
           (line . ,line)
           (column . ,column)
           (focused . ,(if focus-window t :json-false)))))))))
`.trim();

      const payload = await runEmacsEval(runCfg, expr);
      return jsonResult(payload);
    },
  };
}

function createInsertTool(runCfg: EmacsRunConfig): AnyAgentTool {
  return {
    name: "emacs_insert",
    label: "Emacs Insert",
    description:
      "Insert text into a deterministic target window at point/bob/eob/line_column, with optional undo boundary grouping.",
    parameters: INSERT_SCHEMA,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = asRecord(args);
      const text = readStringParam(params, "text", {
        required: true,
        trim: false,
        allowEmpty: true,
      });
      const bufferName = readStringParam(params, "buffer", { trim: true });
      const placement = parseInsertPlacement(params);

      const bufferExpr = bufferName ? toElispBase64DecodeExpr(bufferName) : "nil";

      const expr = `
(progn
  ${ELISP_HELPERS}
  (let* ((txt ${toElispStringOrNil(text)})
         (buffer-name-arg ${bufferExpr})
         (at-mode ${toElispStringOrNil(placement.at)})
         (at-line ${toElispNumberOrNil(placement.line)})
         (at-column ${toElispNumberOrNil(placement.column)})
         (with-undo-boundary ${toElispBool(placement.undoBoundary)})
         (win (if buffer-name-arg
                  (let ((buf (get-buffer buffer-name-arg)))
                    (unless buf (error "buffer not found: %s" buffer-name-arg))
                    (or (get-buffer-window buf t)
                        (let ((w (openclaw--user-active-window)))
                          (set-window-buffer w buf) w)))
                (openclaw--user-active-window))))
    (unless (window-live-p win)
      (error "could not resolve target window"))
    (let* ((frame (window-frame win))
           (buf (window-buffer win)))
      (with-current-buffer buf
        (cond
         ((string= at-mode "bob")
          (goto-char (point-min)))
         ((string= at-mode "eob")
          (goto-char (point-max)))
         ((string= at-mode "line_column")
          (unless at-line
            (error "at=line_column requires line"))
          (goto-char (point-min))
          (forward-line (max 0 (1- at-line)))
          (move-to-column (or at-column 0) t))
         (t
          (goto-char (window-point win))))

        (when with-undo-boundary (undo-boundary))
        (insert txt)
        (when with-undo-boundary (undo-boundary))

        (let* ((point (point))
               (line (save-excursion (goto-char point) (line-number-at-pos point)))
               (column (save-excursion (goto-char point) (current-column))))
          (set-window-point win point)
          (openclaw--emit-json-result
           "emacs_insert"
           (format "buffer=%s inserted=%d at=%s"
                   (buffer-name buf) (length txt) at-mode)
           \`((ok . t)
             (buffer . ,(buffer-name buf))
             (file . ,(buffer-file-name buf))
             (windowId . ,(openclaw--window-id win))
             (frameId . ,(openclaw--frame-id frame))
             (tty . ,(openclaw--window-tty win))
             (point . ,point)
             (line . ,line)
             (column . ,column)
             (insertedChars . ,(length txt))
             (at . ,at-mode)
             (undoBoundary . ,(if with-undo-boundary t :json-false))))))))))
`.trim();

      const payload = await runEmacsEval(runCfg, expr);
      return jsonResult(payload);
    },
  };
}

function createEditTool(runCfg: EmacsRunConfig): AnyAgentTool {
  return {
    name: "emacs_edit",
    label: "Emacs Edit",
    description:
      "Edit a buffer by replacing exact text. The old_string must match exactly (including whitespace). Use this for precise, surgical edits.",
    parameters: EDIT_SCHEMA,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = asRecord(args);
      const bufferName = readStringParam(params, "buffer", { required: true, trim: true });
      const oldString = readStringParam(params, "old_string", { required: true });
      const newString = readStringParam(params, "new_string", { required: true });

      const expr = `
(progn
  ${ELISP_HELPERS}
  (let* ((buffer-name-str ${toElispBase64DecodeExpr(bufferName)})
       (old-text ${toElispBase64DecodeExpr(oldString)})
       (new-text ${toElispBase64DecodeExpr(newString)})
       (buf (get-buffer buffer-name-str)))
  (unless buf
    (error "buffer not found: %s" buffer-name-str))
  (with-current-buffer buf
    (save-excursion
      (goto-char (point-min))
      (let ((case-fold-search nil))
        (unless (search-forward old-text nil t)
          (error "old_string not found in buffer %s" buffer-name-str))
        (let ((match-start (match-beginning 0))
              (match-end (match-end 0)))
          ;; Check for additional matches (ambiguity)
          (when (save-excursion (search-forward old-text nil t))
            (error "old_string matches multiple locations in buffer %s — make it more specific" buffer-name-str))
          (undo-boundary)
          (delete-region match-start match-end)
          (goto-char match-start)
          (insert new-text)
          (undo-boundary)
          (let* ((point (point))
                 (line (line-number-at-pos point))
                 (column (current-column)))
            (openclaw--emit-json-result
             "emacs_edit"
             (format "buffer=%s replaced=%d inserted=%d"
                     (buffer-name buf)
                     (- match-end match-start)
                     (length new-text))
             \`((ok . t)
               (buffer . ,(buffer-name buf))
               (file . ,(buffer-file-name buf))
               (point . ,point)
               (line . ,line)
               (column . ,column)
               (replacedChars . ,(- match-end match-start))
               (insertedChars . ,(length new-text))))))))))))
`.trim();

      const payload = await runEmacsEval(runCfg, expr);
      return jsonResult(payload);
    },
  };
}

function createEvalTool(runCfg: EmacsRunConfig): AnyAgentTool {
  return {
    name: "emacs_eval",
    label: "Emacs Eval",
    description:
      "Evaluate arbitrary Emacs Lisp and return structured channels: value, stdout, messages, and stderr.",
    parameters: EVAL_SCHEMA,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = asRecord(args);
      const expression = readStringParam(params, "expression", { required: true });

      const expr = `
(progn
  ${ELISP_HELPERS}
  (require 'cl-lib)
  (let ((openclaw-out (generate-new-buffer " *openclaw-eval-out*"))
        (openclaw-msg (generate-new-buffer " *openclaw-eval-msg*"))
        (openclaw-err (generate-new-buffer " *openclaw-eval-err*"))
        (openclaw-ok t)
        (openclaw-error nil)
        (openclaw-value nil))
    (unwind-protect
        (progn
          (cl-letf (((symbol-function 'message)
                     (lambda (fmt &rest args)
                       (let ((txt (apply #'format fmt args)))
                         (with-current-buffer openclaw-msg
                           (insert txt "\\n"))
                         txt))))
            (let ((standard-output openclaw-out)
                  (standard-error openclaw-err))
              (message "OpenClaw emacs_eval: evaluating expression")
              (condition-case err
                  (setq openclaw-value
                        ${expression})
                (error
                 (setq openclaw-ok nil)
                 (setq openclaw-error (error-message-string err))))))
          (openclaw--emit-json-result
           "emacs_eval"
           (if openclaw-ok
               "ok"
             (format "error=%s" openclaw-error))
           \`((ok . ,(if openclaw-ok t :json-false))
             (value . ,(prin1-to-string openclaw-value))
             (valueType . ,(symbol-name (type-of openclaw-value)))
             (stdout . ,(with-current-buffer openclaw-out
                          (buffer-substring-no-properties (point-min) (point-max))))
             (messages . ,(with-current-buffer openclaw-msg
                            (buffer-substring-no-properties (point-min) (point-max))))
             (stderr . ,(concat
                         (with-current-buffer openclaw-err
                           (buffer-substring-no-properties (point-min) (point-max)))
                         (if openclaw-error
                             (concat (if (> (buffer-size openclaw-err) 0) "\\n" "") openclaw-error)
                           "")))
             (hadError . ,(if openclaw-ok :json-false t)))))
      (kill-buffer openclaw-out)
      (kill-buffer openclaw-msg)
      (kill-buffer openclaw-err))))
`.trim();

      const payload = await runEmacsEval(runCfg, expr);
      return jsonResult(payload);
    },
  };
}

function createEmacsTools(api: OpenClawPluginApi, ctx: OpenClawPluginToolContext): AnyAgentTool[] | null {
  const cfg = resolvePluginConfig(api, ctx);

  if (ctx.sandboxed && cfg.disableInSandbox) {
    api.logger.info(
      "emacs-tools: skipping registration in sandboxed session (disableInSandbox=true)",
    );
    return null;
  }

  const runCfg = resolveRunConfig(cfg);
  const core = [
    createListTool(runCfg),
    createReadTool(runCfg, cfg),
    createOpenTool(runCfg, cfg, ctx),
    createInsertTool(runCfg),
    createEditTool(runCfg),
    createEvalTool(runCfg),
  ];

  return core;
}

const plugin = {
  id: "emacs-tools",
  name: "Emacs Tools",
  description: "Agent tools to control a running Emacs daemon via emacsclient.",
  register(api: OpenClawPluginApi) {
    api.registerTool((ctx) => createEmacsTools(api, ctx), {
      optional: true,
      names: [
        "emacs_list",
        "emacs_read",
        "emacs_open",
        "emacs_insert",
        "emacs_edit",
        "emacs_eval",
      ],
    });
  },
};

export default plugin;
