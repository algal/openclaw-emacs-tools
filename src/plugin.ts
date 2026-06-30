import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  CONFIG_SCHEMA,
  EDIT_SCHEMA,
  EVAL_SCHEMA,
  INSERT_SCHEMA,
  LIST_SCHEMA,
  OPEN_SCHEMA,
  READ_SCHEMA,
  createEmacsTool,
  resolveEmacsToolsConfig,
  type EmacsCoreTool,
  type EmacsToolContext,
  type EmacsToolName,
} from "./core.js";

function jsonResult(payload: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

function wrapCoreTool(coreTool: EmacsCoreTool): AnyAgentTool {
  return {
    ...coreTool,
    execute: async (toolCallId: string, args: unknown) => {
      const payload = await coreTool.execute(toolCallId, args);
      return jsonResult(payload);
    },
  } as AnyAgentTool;
}

function createEmacsToolForContext(
  api: OpenClawPluginApi,
  ctx: OpenClawPluginToolContext,
  name: EmacsToolName,
): AnyAgentTool | null {
  const toolContext: EmacsToolContext = {
    workspaceDir: typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : undefined,
    sandboxed: Boolean(ctx.sandboxed),
  };
  const cfg = resolveEmacsToolsConfig(api.pluginConfig, toolContext);

  if (toolContext.sandboxed && cfg.disableInSandbox) {
    api.logger.info(
      "emacs-tools: skipping registration in sandboxed session (disableInSandbox=true)",
    );
    return null;
  }

  const coreTool = createEmacsTool(name, cfg, toolContext);
  return coreTool ? wrapCoreTool(coreTool) : null;
}

export default defineToolPlugin({
  id: "emacs-tools",
  name: "Emacs Tools",
  description: "Agent tools to control a running Emacs daemon via emacsclient.",
  configSchema: CONFIG_SCHEMA,
  tools: (tool) => [
    tool({
      name: "emacs_list",
      label: "Emacs List",
      description:
        "List buffers and optionally frames/windows, including stable ids for deterministic targeting.",
      parameters: LIST_SCHEMA,
      optional: true,
      factory: ({ api, toolContext }) =>
        createEmacsToolForContext(api, toolContext, "emacs_list"),
    }),
    tool({
      name: "emacs_read",
      label: "Emacs Read",
      description:
        "Read text from an Emacs buffer. If buffer is omitted, reads the user's currently active window. Returns buffer contents with point/line/column metadata.",
      parameters: READ_SCHEMA,
      optional: true,
      factory: ({ api, toolContext }) =>
        createEmacsToolForContext(api, toolContext, "emacs_read"),
    }),
    tool({
      name: "emacs_open",
      label: "Emacs Open",
      description:
        "Open a file and display it in a deterministic target window, with optional line/column positioning.",
      parameters: OPEN_SCHEMA,
      optional: true,
      factory: ({ api, toolContext }) =>
        createEmacsToolForContext(api, toolContext, "emacs_open"),
    }),
    tool({
      name: "emacs_insert",
      label: "Emacs Insert",
      description:
        "Insert text into a deterministic target window at point/bob/eob/line_column, with optional undo boundary grouping.",
      parameters: INSERT_SCHEMA,
      optional: true,
      factory: ({ api, toolContext }) =>
        createEmacsToolForContext(api, toolContext, "emacs_insert"),
    }),
    tool({
      name: "emacs_edit",
      label: "Emacs Edit",
      description:
        "Edit a buffer by replacing exact text after OpenClaw-style parameter normalization. Use this for precise, surgical edits.",
      parameters: EDIT_SCHEMA,
      optional: true,
      factory: ({ api, toolContext }) =>
        createEmacsToolForContext(api, toolContext, "emacs_edit"),
    }),
    tool({
      name: "emacs_eval",
      label: "Emacs Eval",
      description:
        "Evaluate arbitrary Emacs Lisp and return structured channels: value, stdout, messages, and stderr.",
      parameters: EVAL_SCHEMA,
      optional: true,
      factory: ({ api, toolContext }) =>
        createEmacsToolForContext(api, toolContext, "emacs_eval"),
    }),
  ],
});
