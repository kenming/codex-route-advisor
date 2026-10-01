#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { dispatchResponsesRequest } from "./dispatcher.mjs";

const DEFAULTS = {
  sourceModel: "gpt-5.6-luna",
  sourceEffort: "medium",
  targetModel: "gpt-5.6-sol",
  targetEffort: "xhigh",
  prompt: "Reply with exactly: LOOPBACK_DISPATCH_OK",
  cwd: process.cwd(),
};

const PROVIDER = "route_spike";
const UPSTREAM = new URL("https://chatgpt.com/backend-api/codex");

function usage() {
  console.log(`Ephemeral loopback dispatch spike

Usage:
  node spike-loopback-dispatch.mjs [options]

Options:
  --source-model <slug>    Model Codex sends to the proxy (default: ${DEFAULTS.sourceModel})
  --source-effort <level>  Effort Codex sends to the proxy (default: ${DEFAULTS.sourceEffort})
  --target-model <slug>    Model proxy forwards upstream (default: ${DEFAULTS.targetModel})
  --target-effort <level>  Effort proxy forwards upstream (default: ${DEFAULTS.targetEffort})
  --prompt <text>          Test prompt
  --cwd <path>             Codex working directory
  --dry-run                Validate catalog and print the planned invocation only
  --help                   Show this help
`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, dryRun: false };
  const valueArgs = new Set([
    "--source-model",
    "--source-effort",
    "--target-model",
    "--target-effort",
    "--prompt",
    "--cwd",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (!valueArgs.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}`);
    const key = arg
      .slice(2)
      .replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    opts[key] = value;
  }
  return opts;
}

function resolveCodexInvocation() {
  if (process.platform !== "win32") {
    return { command: "codex", prefix: [], display: "codex", source: "PATH:codex" };
  }

  const whereCmd = spawnSync("where.exe", ["codex.cmd"], { encoding: "utf8" });
  const shim = whereCmd.status === 0 ? whereCmd.stdout.split(/\r?\n/u).find(Boolean) : null;
  if (shim) {
    const entry = join(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(entry)) throw new Error(`Codex npm entry not found: ${entry}`);
    return { command: process.execPath, prefix: [entry], display: "codex", source: shim };
  }

  const whereExe = spawnSync("where.exe", ["codex.exe"], { encoding: "utf8" });
  const executable = whereExe.status === 0 ? whereExe.stdout.split(/\r?\n/u).find(Boolean) : null;
  if (executable) return { command: executable, prefix: [], display: "codex", source: executable };

  throw new Error("Codex CLI was not found on PATH");
}

const codex = resolveCodexInvocation();

function runCodexSync(args) {
  const result = spawnSync(codex.command, [...codex.prefix, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function readCatalog() {
  const result = runCodexSync(["debug", "models"]);
  if (result.status !== 0) {
    throw new Error(`codex debug models failed:\n${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed.models)) throw new Error("Unexpected model catalog shape");
  return parsed.models;
}

function requireModelEffort(models, modelSlug, effort, label) {
  const model = models.find((item) => item.slug === modelSlug);
  if (!model) throw new Error(`${label} model not found in runtime catalog: ${modelSlug}`);
  const efforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map((item) => item.effort)
    : [];
  if (!efforts.includes(effort)) {
    throw new Error(
      `${label} effort "${effort}" is unsupported by ${modelSlug}. Supported: ${efforts.join(", ")}`,
    );
  }
  return { model, efforts };
}

function quoteForDisplay(value) {
  const text = String(value);
  return /\s|"/u.test(text) ? JSON.stringify(text) : text;
}

function requestPath(url = "/") {
  return `${UPSTREAM.pathname.replace(/\/$/u, "")}${url.startsWith("/") ? url : `/${url}`}`;
}

function headerPresent(headers, name) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function summarizeRequestEnvelope(body, headers) {
  const metadata = body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata
    : null;
  const safeHeaderNames = [
    "originator",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-turn-metadata",
    "x-codex-window-id",
    "x-openai-internal-codex-responses-lite",
  ];
  return {
    topLevelKeys: Object.keys(body ?? {}).sort(),
    metadataKeys: metadata ? Object.keys(metadata).sort() : [],
    metadataIdentifiers: metadata
      ? Object.fromEntries(
        Object.entries(metadata).filter(([key, value]) =>
          /(?:turn|thread|request|session|conversation|source|origin|client)/iu.test(key)
          && ["string", "number", "boolean"].includes(typeof value),
        ),
      )
      : {},
    headerNames: Object.keys(headers ?? {}).map((key) => key.toLowerCase()).sort(),
    safeHeaders: Object.fromEntries(
      safeHeaderNames
        .map((name) => [name, headers?.[name]])
        .filter(([, value]) => value !== undefined),
    ),
    inputItemTypes: Array.isArray(body?.input)
      ? body.input.map((item) => item?.type ?? typeof item)
      : [],
  };
}

function startLoopbackProxy({ targetModel, targetEffort, observations }) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let outboundBody = Buffer.concat(chunks);
      let observation = null;

      if (req.method === "POST" && /\/responses(?:\?|$)/u.test(req.url ?? "")) {
        try {
          const body = JSON.parse(outboundBody.toString("utf8"));
          const before = {
            model: body.model ?? null,
            reasoningEffort: body.reasoning?.effort ?? null,
          };

          const dispatched = dispatchResponsesRequest({
            decision: {
              model: targetModel,
              reasoningEffort: targetEffort,
              dispatchStatus: "not_dispatched",
            },
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
          });

          if (dispatched.rewriteApplied) {
            outboundBody = Buffer.from(JSON.stringify(dispatched.body));
          }

          observation = {
            method: req.method,
            path: req.url,
            envelope: summarizeRequestEnvelope(body, req.headers),
            classification: dispatched.classification,
            before,
            after: dispatched.rewriteApplied ? {
              model: dispatched.body.model,
              reasoningEffort: dispatched.body.reasoning?.effort ?? null,
            } : null,
            rewriteApplied: dispatched.rewriteApplied,
            authorizationPresent: headerPresent(req.headers, "authorization"),
            chatgptAccountIdPresent: headerPresent(req.headers, "chatgpt-account-id"),
            upstreamStatus: null,
          };
          observations.push(observation);
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `proxy rewrite failed: ${error.message}` } }));
          return;
        }
      }

      const headers = { ...req.headers, host: UPSTREAM.host };
      delete headers["content-length"];
      delete headers.connection;

      const upstream = https.request(
        {
          protocol: UPSTREAM.protocol,
          hostname: UPSTREAM.hostname,
          port: UPSTREAM.port || undefined,
          method: req.method,
          path: requestPath(req.url),
          headers,
        },
        (upstreamResponse) => {
          if (observation) observation.upstreamStatus = upstreamResponse.statusCode ?? null;
          const responseHeaders = { ...upstreamResponse.headers };
          delete responseHeaders["content-length"];
          res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(res);
        },
      );

      upstream.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: error.message, type: "proxy_error" } }));
      });

      req.on("aborted", () => upstream.destroy());
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });

      if (outboundBody.length) upstream.write(outboundBody);
      upstream.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine loopback proxy port"));
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function runCodexAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(codex.command, [...codex.prefix, ...args], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function buildExecArgs(opts, baseUrl) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--color", "never",
    "--json",
    "--model", opts.sourceModel,
    "--config", `model_reasoning_effort="${opts.sourceEffort}"`,
    "--config", `model_provider="${PROVIDER}"`,
    "--config", `model_providers.${PROVIDER}.name="Route Spike"`,
    "--config", `model_providers.${PROVIDER}.base_url="${baseUrl}"`,
    "--config", `model_providers.${PROVIDER}.wire_api="responses"`,
    "--config", `model_providers.${PROVIDER}.requires_openai_auth=true`,
    "--config", `model_providers.${PROVIDER}.supports_websockets=false`,
    "--cd", opts.cwd,
    opts.prompt,
  ];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const version = runCodexSync(["--version"]);
  if (version.status !== 0) throw new Error(version.stderr || "codex --version failed");

  const models = readCatalog();
  const source = requireModelEffort(models, opts.sourceModel, opts.sourceEffort, "Source");
  const target = requireModelEffort(models, opts.targetModel, opts.targetEffort, "Target");

  const observations = [];
  const { server, baseUrl } = await startLoopbackProxy({
    targetModel: opts.targetModel,
    targetEffort: opts.targetEffort,
    observations,
  });

  const execArgs = buildExecArgs(opts, baseUrl);

  console.log(`Codex: ${version.stdout.trim()}`);
  console.log(`Resolved launcher: ${codex.source}`);
  console.log(`Proxy: ${baseUrl}`);
  console.log(`Source: ${source.model.slug} / ${opts.sourceEffort}`);
  console.log(`Target: ${target.model.slug} / ${opts.targetEffort}`);
  console.log(`Invocation: ${codex.display} ${execArgs.map(quoteForDisplay).join(" ")}`);

  if (opts.dryRun) {
    await closeServer(server);
    console.log("RESULT: LOOPBACK_DISPATCH_DRY_RUN_OK");
    return;
  }

  let result;
  try {
    result = await runCodexAsync(execArgs);
  } finally {
    await closeServer(server);
  }

  const markerSeen = result.stdout.includes("LOOPBACK_DISPATCH_OK");
  const rewritten = observations.filter(
    (item) => item.rewriteApplied
      && item.after?.model === opts.targetModel
      && item.after?.reasoningEffort === opts.targetEffort,
  );
  const authForwardable = observations.some((item) => item.authorizationPresent);
  const upstreamAccepted = observations.some(
    (item) => Number.isInteger(item.upstreamStatus)
      && item.upstreamStatus >= 200
      && item.upstreamStatus < 300,
  );

  console.log(`Exit code: ${result.code}`);
  console.log(`Marker seen: ${markerSeen}`);
  console.log(`Intercepted /responses requests: ${observations.length}`);
  console.log(`Rewritten to requested target: ${rewritten.length}/${observations.length}`);
  console.log(`Authorization header present at proxy boundary: ${authForwardable}`);
  console.log(`At least one upstream 2xx: ${upstreamAccepted}`);
  console.log("Proxy observations (credential values and prompt bodies intentionally omitted):");
  console.log(JSON.stringify(observations, null, 2));
  console.log("--- raw stdout ---");
  process.stdout.write(result.stdout);
  console.log("--- raw stderr ---");
  process.stderr.write(result.stderr);

  const ok = result.code === 0
    && markerSeen
    && observations.length > 0
    && rewritten.length === observations.length
    && authForwardable
    && upstreamAccepted;

  if (!ok) {
    console.log("RESULT: LOOPBACK_DISPATCH_FAILED");
    process.exit(result.code || 4);
  }

  console.log("RESULT: LOOPBACK_DISPATCH_EXECUTION_OK");
}

main().catch((error) => {
  console.error(`SPIKE_ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
