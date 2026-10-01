#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { dispatchResponsesRequest } from "./dispatcher.mjs";

const CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const UPSTREAM = new URL("https://chatgpt.com/backend-api/codex");
const DEFAULTS = {
  sourceModel: "gpt-5.6-luna",
  sourceEffort: "medium",
  targetModel: "gpt-5.6-sol",
  targetEffort: "xhigh",
};

function usage() {
  console.log(`VSCode Codex native loopback dispatch spike

Usage:
  node spike-app-loopback-dispatch.mjs [options]

Options:
  --source-model <slug>    Temporary root model for new App threads
  --source-effort <level>  Temporary root reasoning effort
  --target-model <slug>    Proxy rewrite target model
  --target-effort <level>  Proxy rewrite target reasoning effort
  --dry-run                Inspect config and print planned temporary changes only
  --help                   Show this help

Important:
  Run this from a separate terminal, not from a Codex App tool call.
  While it is running, fully quit and reopen VSCode, create a NEW chat,
  and send: Reply with exactly: VSCODE_LOOPBACK_DISPATCH_OK
  After the proxy reports the request, fully quit Codex App again, then press Ctrl+C here.
  The original ~/.codex/config.toml is restored byte-for-byte on shutdown.
`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, dryRun: false };
  const keys = new Map([
    ["--source-model", "sourceModel"],
    ["--source-effort", "sourceEffort"],
    ["--target-model", "targetModel"],
    ["--target-effort", "targetEffort"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    const key = keys.get(arg);
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}`);
    opts[key] = value;
  }
  return opts;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function rootPrefixEnd(text) {
  const match = /^\s*\[[^\r\n]+\]/mu.exec(text);
  return match ? match.index : text.length;
}

function setRootKey(prefix, key, valueLiteral) {
  const line = `${key} = ${valueLiteral}`;
  const re = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*=.*$`, "mu");
  if (re.test(prefix)) return prefix.replace(re, line);
  const needsBreak = prefix.length > 0 && !/\r?\n$/u.test(prefix);
  return `${prefix}${needsBreak ? "\n" : ""}${line}\n`;
}

function buildTemporaryConfig(original, { sourceModel, sourceEffort, providerId, baseUrl }) {
  const text = original.toString("utf8");
  const cut = rootPrefixEnd(text);
  let prefix = text.slice(0, cut);
  const suffix = text.slice(cut);

  prefix = setRootKey(prefix, "model", JSON.stringify(sourceModel));
  prefix = setRootKey(prefix, "model_reasoning_effort", JSON.stringify(sourceEffort));
  prefix = setRootKey(prefix, "model_provider", JSON.stringify(providerId));

  const providerBlock = [
    "",
    `[model_providers.${providerId}]`,
    'name = "VSCode Codex Route Spike"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    "",
  ].join("\n");

  return Buffer.from(`${prefix}${suffix.replace(/\s*$/u, "")}${providerBlock}`, "utf8");
}

function atomicWrite(path, data) {
  const temp = `${path}.route-spike-${process.pid}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

function upstreamPath(url = "/") {
  return `${UPSTREAM.pathname.replace(/\/$/u, "")}${url.startsWith("/") ? url : `/${url}`}`;
}

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function requestIdentity(headers) {
  const rawTurnMetadata = headers["x-codex-turn-metadata"];
  let turnMetadata = null;
  if (typeof rawTurnMetadata === "string") {
    try {
      turnMetadata = JSON.parse(rawTurnMetadata);
    } catch {
      turnMetadata = { parseError: true };
    }
  }
  return {
    originator: headers.originator ?? null,
    sessionId: headers["session-id"] ?? null,
    threadId: headers["thread-id"] ?? null,
    clientRequestId: headers["x-client-request-id"] ?? null,
    windowId: headers["x-codex-window-id"] ?? null,
    responsesLite: headers["x-openai-internal-codex-responses-lite"] ?? null,
    turnMetadata,
  };
}

function findMarkerPaths(value, marker, path = "$", matches = []) {
  if (typeof value === "string") {
    if (value.includes(marker)) matches.push(path);
    return matches;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findMarkerPaths(item, marker, `${path}[${index}]`, matches));
    return matches;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      findMarkerPaths(item, marker, `${path}.${key}`, matches);
    }
  }
  return matches;
}

function startProxy(opts) {
  const observations = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let out = Buffer.concat(chunks);
      let observation = null;

      if (req.method === "POST" && /\/responses(?:\?|$)/u.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString("utf8"));
          const markerPaths = findMarkerPaths(body, "VSCODE_LOOPBACK_DISPATCH_OK");
          const dispatched = dispatchResponsesRequest({
            decision: {
              model: opts.targetModel,
              reasoningEffort: opts.targetEffort,
              dispatchStatus: "not_dispatched",
            },
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
          });
          observation = {
            at: new Date().toISOString(),
            method: req.method,
            path: req.url,
            identity: requestIdentity(req.headers),
            classification: dispatched.classification,
            before: {
              model: body.model ?? null,
              reasoningEffort: body.reasoning?.effort ?? null,
            },
            after: dispatched.rewriteApplied ? {
              model: dispatched.body.model,
              reasoningEffort: dispatched.body.reasoning?.effort ?? null,
            } : null,
            rewriteApplied: dispatched.rewriteApplied,
            authorizationPresent: hasHeader(req.headers, "authorization"),
            chatgptAccountIdPresent: hasHeader(req.headers, "chatgpt-account-id"),
            upstreamStatus: null,
            markerSeenInRequest: markerPaths.length > 0,
            markerPaths,
          };

          if (dispatched.rewriteApplied) {
            out = Buffer.from(JSON.stringify(dispatched.body));
          }
          observations.push(observation);

          console.log("VSCODE_NATIVE_RESPONSE_INTERCEPT");
          console.log(JSON.stringify(observation, null, 2));
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `proxy rewrite failed: ${error.message}` } }));
          return;
        }
      }

      const headers = { ...req.headers, host: UPSTREAM.host };
      delete headers["content-length"];
      delete headers.connection;

      const upstream = https.request({
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || undefined,
        method: req.method,
        path: upstreamPath(req.url),
        headers,
      }, (upstreamResponse) => {
        if (observation) {
          observation.upstreamStatus = upstreamResponse.statusCode ?? null;
          console.log(`VSCODE_NATIVE_UPSTREAM_STATUS: ${observation.upstreamStatus}`);
        }
        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders["content-length"];
        res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(res);
      });

      upstream.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: error.message, type: "proxy_error" } }));
      });

      req.on("aborted", () => upstream.destroy());
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine loopback port"));
        return;
      }
      resolve({ server, observations, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Codex config not found: ${CONFIG_PATH}`);
  }

  const original = readFileSync(CONFIG_PATH);
  const originalHash = sha256(original);
  const backupPath = `${CONFIG_PATH}.route-spike-backup-${process.pid}`;

  if (opts.dryRun) {
    const preview = buildTemporaryConfig(original, {
      ...opts,
      providerId: "route_spike_preview",
      baseUrl: "http://127.0.0.1:<ephemeral-port>",
    });
    console.log(`Config: ${CONFIG_PATH}`);
    console.log(`Original SHA-256: ${originalHash}`);
    console.log(`Temporary config bytes: ${preview.length}`);
    console.log(`Source: ${opts.sourceModel} / ${opts.sourceEffort}`);
    console.log(`Target: ${opts.targetModel} / ${opts.targetEffort}`);
    console.log("No files modified.");
    console.log("RESULT: VSCODE_LOOPBACK_DRY_RUN_OK");
    return;
  }

  const { server, observations, baseUrl } = await startProxy(opts);
  writeFileSync(backupPath, original, { flag: "wx" });
  const providerId = `route_spike_${process.pid}`;
  const temporary = buildTemporaryConfig(original, {
    ...opts,
    providerId,
    baseUrl,
  });

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    try {
      const recoveryBytes = existsSync(backupPath) ? readFileSync(backupPath) : original;
      atomicWrite(CONFIG_PATH, recoveryBytes);
      console.log(`CONFIG_RESTORED_SHA256: ${sha256(readFileSync(CONFIG_PATH))}`);
      if (existsSync(backupPath)) unlinkSync(backupPath);
    } finally {
      await closeServer(server).catch(() => {});
    }
  };

  const shutdown = async (signal) => {
    console.log(`SHUTDOWN: ${signal}`);
    await restore();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  atomicWrite(CONFIG_PATH, temporary);

  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Original SHA-256: ${originalHash}`);
  console.log(`Recovery backup: ${backupPath}`);
  console.log(`Temporary SHA-256: ${sha256(temporary)}`);
  console.log(`Provider: ${providerId}`);
  console.log(`Proxy: ${baseUrl}`);
  console.log(`Source default: ${opts.sourceModel} / ${opts.sourceEffort}`);
  console.log(`Rewrite target: ${opts.targetModel} / ${opts.targetEffort}`);
  console.log("");
  console.log("NEXT:");
  console.log("1. Fully quit VSCode.");
  console.log("2. Reopen VSCode and open the AgentSkills workspace.");
  console.log("3. Open the Codex extension and create a NEW chat in this workspace.");
  console.log("4. Send exactly: Reply with exactly: VSCODE_LOOPBACK_DISPATCH_OK");
  console.log("5. Confirm this terminal prints VSCODE_NATIVE_RESPONSE_INTERCEPT and VSCODE_NATIVE_UPSTREAM_STATUS: 200.");
  console.log("6. Fully quit VSCode again.");
  console.log("7. Press Ctrl+C here to restore the original config.");
  console.log("");
  console.log("Do not close this terminal before the test is complete.");

  // Keep the process alive until explicit shutdown.
  setInterval(() => {
    const matches = observations.filter((item) =>
      item.markerSeenInRequest
      && item.after?.model === opts.targetModel
      && item.after?.reasoningEffort === opts.targetEffort
      && Number.isInteger(item.upstreamStatus)
      && item.upstreamStatus >= 200
      && item.upstreamStatus < 300
    );
    if (matches.length > 0) {
      console.log(`VSCODE_NATIVE_DISPATCH_OBSERVED: ${matches.length}`);
    }
  }, 5000).unref();

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(`SPIKE_ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
