#!/usr/bin/env node

const provider = "typesafe";
const model = "jev-latest";
const endpoint = "https://api.typesafe.ai/v1/systemone";
const timeoutMs = 15_000;
const apiKey = process.env.TYPESAFE_API_KEY?.trim();

function fail(error, details = {}) {
  process.stdout.write(`${JSON.stringify({ state: "unavailable", provider, error, ...details })}\n`);
  process.exitCode = 1;
}

function isTimeout(error) {
  return error?.name === "TimeoutError"
    || error?.code === "UND_ERR_CONNECT_TIMEOUT"
    || error?.cause?.code === "ETIMEDOUT"
    || error?.cause?.code === "UND_ERR_CONNECT_TIMEOUT";
}

async function main() {
  if (!apiKey) {
    fail("missing_api_key");
    return;
  }

  const body = {
    state: "capability verification",
    model,
    questions: {
      capability: {
        type: "noul",
        instructions: "Is this a capability verification probe?",
      },
    },
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail("network_error", { reason: isTimeout(error) ? "timeout" : "request_failed" });
    return;
  }

  if (!response.ok) {
    const error = response.status === 401 || response.status === 403
      ? "auth_error"
      : response.status === 402 || response.status === 429
        ? "quota_error"
        : response.status === 408
          ? "network_error"
          : "service_error";
    fail(error, {
      ...(response.status === 408 ? { reason: "timeout" } : {}),
      status: response.status,
    });
    return;
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    fail("network_error", { reason: isTimeout(error) ? "timeout" : "response_read_failed" });
    return;
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    fail("invalid_response");
    return;
  }

  const answer = result?.answers?.capability;
  if (result && typeof result.model === "string"
    && answer?.type === "noul"
    && typeof answer.noul === "number"
    && Number.isFinite(answer.noul)
    && answer.noul >= 0 && answer.noul <= 1) {
    process.stdout.write(`${JSON.stringify({ state: "available", provider, model })}\n`);
  } else {
    fail("invalid_response");
  }
}

await main().catch(() => fail("service_error"));
