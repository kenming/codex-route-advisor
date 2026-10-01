#!/usr/bin/env node

import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function discoveryError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

export function normalizeCodexModelInventory(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw discoveryError(
      "invalid_provider_response",
      "Codex model source must return an object",
    );
  }
  if (!Array.isArray(payload.models)) {
    throw discoveryError(
      "invalid_provider_response",
      "Codex model source response requires a models array",
    );
  }

  const seen = new Set();
  return payload.models.map((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) {
      throw discoveryError(
        "invalid_provider_response",
        "Each Codex model entry must be an object",
      );
    }
    if (typeof model.slug !== "string" || !model.slug.trim()) {
      throw discoveryError(
        "invalid_provider_response",
        "Each Codex model entry requires a non-empty slug",
      );
    }

    const id = model.slug.trim();
    if (id !== model.slug || seen.has(id)) {
      throw discoveryError(
        "invalid_provider_response",
        `Codex model slug must be canonical and unique: ${model.slug}`,
      );
    }
    seen.add(id);

    return {
      id,
      available: model.visibility === "list",
    };
  });
}

export async function runCodexDebugModels({
  binary = process.platform === "win32" ? "codex.cmd" : "codex",
  timeoutMs = 10_000,
  exec = execFileAsync,
} = {}) {
  const executable = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : binary;
  const args = process.platform === "win32"
    ? ["/d", "/c", binary, "debug", "models"]
    : ["debug", "models"];

  let stdout;
  try {
    const result = await exec(executable, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (error) {
    throw discoveryError(
      "provider_unavailable",
      `Unable to read Codex model catalog: ${error?.message ?? "unknown error"}`,
      { cause: error },
    );
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw discoveryError(
      "invalid_provider_response",
      `Codex debug models returned invalid JSON: ${error.message}`,
    );
  }
}

export async function discoverCodexModels(options = {}) {
  const payload = options.payload ?? await runCodexDebugModels(options);
  return {
    inventory: normalizeCodexModelInventory(payload),
  };
}
