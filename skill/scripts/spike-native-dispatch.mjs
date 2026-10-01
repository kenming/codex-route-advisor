#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const DEFAULTS = {
  model: "gpt-5.6-sol",
  effort: "xhigh",
  prompt: "Reply with exactly: DISPATCH_TEST_OK",
  cwd: process.cwd(),
};

function usage() {
  console.log(`Native Codex dispatch capability spike

Usage:
  node spike-native-dispatch.mjs [options]

Options:
  --model <slug>       Model slug (default: ${DEFAULTS.model})
  --effort <level>     Reasoning effort (default: ${DEFAULTS.effort})
  --prompt <text>      Test prompt
  --cwd <path>         Codex working directory
  --bundled-catalog    Use bundled catalog instead of refreshed runtime catalog
  --dry-run            Validate capability and print invocation without executing
  --help               Show this help
`);
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, bundledCatalog: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") return { help: true };
    if (arg === "--bundled-catalog") opts.bundledCatalog = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (["--model", "--effort", "--prompt", "--cwd"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      opts[arg.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function resolveCodexInvocation() {
  if (process.platform !== "win32") {
    return { command: "codex", prefix: [], display: "codex" };
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

function runCodex(args) {
  const result = spawnSync(codex.command, [...codex.prefix, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}
function readCatalog(useBundled) {
  const args = ["debug", "models"];
  if (useBundled) args.push("--bundled");
  const result = runCodex(args);
  if (result.status !== 0) {
    throw new Error(`codex debug models failed:\n${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed.models)) throw new Error("Unexpected model catalog shape");
  return parsed.models;
}

function validateCapability(models, modelSlug, effort) {
  const model = models.find((item) => item.slug === modelSlug);
  if (!model) {
    const visible = models.filter((item) => item.visibility === "list").map((item) => item.slug);
    throw new Error(`Model not found: ${modelSlug}\nVisible models: ${visible.join(", ")}`);
  }
  const levels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map((item) => item.effort)
    : [];
  if (!levels.includes(effort)) {
    throw new Error(
      `Effort "${effort}" is not supported by ${modelSlug}. Supported: ${levels.join(", ")}`,
    );
  }
  return { model, levels };
}

function quoteForDisplay(value) {
  const text = String(value);
  return /\s|"/u.test(text) ? JSON.stringify(text) : text;
}

function extractEvidence(jsonl) {
  const hits = [];
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const visit = (value, keyPath = "") => {
        if (value && typeof value === "object") {
          for (const [key, child] of Object.entries(value)) {
            const path = keyPath ? `${keyPath}.${key}` : key;
            if (/model|effort|reasoning/iu.test(key) && typeof child !== "object") {
              hits.push({ path, value: child });
            }
            visit(child, path);
          }
        }
      };
      visit(event);
    } catch {
      // Non-JSON output is preserved in raw stdout but ignored for structured evidence.
    }
  }
  return hits;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }

  const version = runCodex(["--version"]);
  if (version.status !== 0) throw new Error(version.stderr || "codex --version failed");
  const models = readCatalog(opts.bundledCatalog);
  const { model, levels } = validateCapability(models, opts.model, opts.effort);

  const execArgs = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--color", "never",
    "--json",
    "--model", opts.model,
    "--config", `model_reasoning_effort="${opts.effort}"`,
    "--cd", opts.cwd,
    opts.prompt,
  ];

  console.log(`Codex: ${version.stdout.trim()}`);
  console.log(`Resolved launcher: ${codex.source ?? codex.command}`);
  console.log(`Catalog: ${opts.bundledCatalog ? "bundled" : "runtime"}`);
  console.log(`Model: ${model.slug}`);
  console.log(`Supported efforts: ${levels.join(", ")}`);
  console.log(`Requested effort: ${opts.effort}`);
  console.log(`Invocation: ${codex.display} ${execArgs.map(quoteForDisplay).join(" ")}`);

  if (opts.dryRun) {
    console.log("RESULT: CAPABILITY_VALIDATED_DRY_RUN");
    return;
  }

  const result = runCodex(execArgs);
  const evidence = extractEvidence(result.stdout || "");
  const markerSeen = (result.stdout || "").includes("DISPATCH_TEST_OK");
  console.log(`Exit code: ${result.status}`);
  console.log(`Marker seen: ${markerSeen}`);
  console.log("Structured model/effort evidence:");
  console.log(evidence.length ? JSON.stringify(evidence, null, 2) : "(none emitted in JSONL)");
  console.log("--- raw stdout ---");
  process.stdout.write(result.stdout || "");
  console.log("--- raw stderr ---");
  process.stderr.write(result.stderr || "");

  if (result.status !== 0) process.exit(result.status ?? 1);
  if (!markerSeen) process.exit(3);
  console.log("RESULT: NATIVE_DISPATCH_EXECUTION_OK");
}

try {
  main();
} catch (error) {
  console.error(`SPIKE_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
