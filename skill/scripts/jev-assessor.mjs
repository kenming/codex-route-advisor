#!/usr/bin/env node

import process from "node:process";

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 15_000;
const TIERS = new Set(["fast", "balanced", "strong", "long"]);

const ROUTING_CRITERIA = Object.freeze({
  fast: "Clear, local, low-risk work with deterministic implementation or verification and little engineering judgment.",
  balanced: "Ordinary engineering work requiring moderate judgment, coordination, or implementation decisions.",
  strong: "Ambiguous diagnosis, architecture trade-offs, high-risk changes, or deep reasoning with meaningful uncertainty.",
  long: "Broad-context redesign, migration, rollout, or sustained cross-system reasoning over a long horizon.",
});

function backendError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function taskState(task) {
  return {
    goal: task?.goal ?? "",
    context: task?.context ?? {},
    deliverable: task?.deliverable ?? "",
    acceptance: task?.acceptance ?? [],
    boundaryReason: task?.boundaryReason ?? "",
    dependencies: task?.dependsOn ?? [],
    conditional: task?.conditional ?? false,
  };
}

export function buildJevRoutingRequest(task, { model = DEFAULT_MODEL } = {}) {
  return {
    state: taskState(task),
    model,
    questions: {
      routing_tier: {
        type: "choice",
        instructions: {
          question: "Which routing tier is the minimum sufficient capability for this bounded software-engineering task?",
          guidance: "Choose based on required reasoning, ambiguity, risk, scope, tools, and validation. Do not choose a concrete model.",
        },
        criteria: ROUTING_CRITERIA,
      },
    },
  };
}

function classifyHttpFailure(response) {
  if (response.status === 401 || response.status === 403) return "auth_error";
  if (response.status === 402 || response.status === 429) return "quota_error";
  if (response.status === 408) return "network_error";
  if (response.status === 529) return "service_overloaded";
  return "service_error";
}

export async function assessBoundedTaskWithJev(task, {
  apiKey = process.env.TYPESAFE_API_KEY?.trim(),
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    throw backendError("missing_api_key", "TYPESAFE_API_KEY is not configured");
  }
  if (typeof fetchImpl !== "function") {
    throw backendError("jev_unavailable", "Fetch API is not available");
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildJevRoutingRequest(task, { model })),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw backendError(
      "network_error",
      "Jev routing request failed",
      { cause: error },
    );
  }

  if (!response.ok) {
    throw backendError(
      classifyHttpFailure(response),
      `Jev routing request failed with HTTP ${response.status}`,
      { status: response.status },
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw backendError("invalid_response", "Jev returned invalid JSON", { cause: error });
  }

  const answer = payload?.answers?.routing_tier;
  if (
    answer?.type !== "choice"
    || !TIERS.has(answer.choice)
    || typeof answer.confidence !== "number"
    || !Number.isFinite(answer.confidence)
    || answer.confidence < 0
    || answer.confidence > 1
  ) {
    throw backendError("invalid_response", "Jev returned an invalid routing assessment");
  }

  return {
    tier: answer.choice,
    confidence: answer.confidence,
    reason: `Jev selected ${answer.choice} as the minimum sufficient routing tier`,
  };
}
