#!/usr/bin/env node

export const ROUTING_TIERS = Object.freeze(["fast", "balanced", "strong", "long"]);

export const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

export const MODEL_FAMILIES = Object.freeze({
  luna: Object.freeze({ family: "luna", tiers: Object.freeze(["fast"]) }),
  sol: Object.freeze({ family: "sol", tiers: Object.freeze(["balanced", "strong"]) }),
  astra: Object.freeze({ family: "astra", tiers: Object.freeze(["long"]) }),
});

export const DEFAULT_ROUTING_PREFERENCES = Object.freeze({
  fast: Object.freeze({ model: "gpt-6-luna", effort: "high" }),
  balanced: Object.freeze({ model: "gpt-6.1-sol", effort: "medium" }),
  strong: Object.freeze({ model: "gpt-6.1-sol", effort: "xhigh" }),
  long: Object.freeze({ model: "gpt-6-astra", effort: "medium" }),
});

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

export class RoutingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRoutingDecision(raw, backend) {
  if (backend !== "jev" && backend !== "model") {
    throw new RoutingError("invalid_backend", `Unsupported router backend: ${backend}`, { backend });
  }
  if (!isPlainObject(raw)) {
    throw new RoutingError("invalid_response", "Router returned a non-object decision");
  }

  const { tier, confidence, reason } = raw;
  if (raw.backend !== undefined && raw.backend !== backend) {
    throw new RoutingError("invalid_response", "Router backend does not match the invoked backend", {
      backend: raw.backend,
      expectedBackend: backend,
    });
  }
  if (!ROUTING_TIERS.includes(tier)) {
    throw new RoutingError("invalid_response", `Unsupported routing tier: ${tier}`, { tier });
  }
  if (
    typeof confidence !== "number"
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 1
  ) {
    throw new RoutingError("invalid_response", "Router confidence must be between 0 and 1", {
      confidence,
    });
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new RoutingError("invalid_response", "Router reason must be a non-empty string", {
      field: "reason",
    });
  }

  return {
    tier,
    backend,
    confidence,
    reason: reason.trim(),
  };
}

export function selectRouterBackend(routerPreference) {
  if (routerPreference === "jev") return "jev";
  if (routerPreference === "model") return "model";
  if (routerPreference?.backend === "jev") return "jev";
  if (routerPreference?.backend === "model") return "model";
  if (routerPreference?.backend === "auto" && routerPreference.prefer === "jev") return "jev";
  if (routerPreference?.prefer === "jev") return "jev";
  return "model";
}

function fallbackReason(error) {
  if (new Set(["unavailable", "jev_unavailable", "missing_api_key"]).has(error?.code)) {
    return "unavailable";
  }
  return typeof error?.code === "string" && error.code
    ? error.code
    : "backend_failure";
}

function isLowConfidence(decision, threshold) {
  return decision.confidence < threshold;
}

export async function routeTask({
  task,
  routerPreference,
  jevRouter,
  modelRouter,
  confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
} = {}) {
  if (
    typeof confidenceThreshold !== "number"
    || !Number.isFinite(confidenceThreshold)
    || confidenceThreshold < 0
    || confidenceThreshold > 1
  ) {
    throw new RoutingError(
      "invalid_confidence_policy",
      "confidenceThreshold must be between 0 and 1",
      { confidenceThreshold },
    );
  }

  const runModel = async (fallback = null) => {
    if (typeof modelRouter !== "function") {
      throw new RoutingError("model_router_unavailable", "Model Router is not available");
    }

    let raw;
    try {
      raw = await modelRouter(
        task,
        fallback
          ? { reason: fallback.reason, jevDecision: fallback.jevDecision ?? null }
          : { reason: "selected" },
      );
    } catch (error) {
      throw new RoutingError("model_router_failure", "Model Router failed", { cause: error });
    }

    const decision = normalizeRoutingDecision(raw, "model");
    if (isLowConfidence(decision, confidenceThreshold)) {
      throw new RoutingError(
        "clarification_required",
        "Routing remains ambiguous; request missing task requirements instead of escalating capability",
        {
          tier: decision.tier,
          confidence: decision.confidence,
          reason: decision.reason,
          fallback: fallback
            ? { from: "jev", reason: fallback.reason }
            : null,
        },
      );
    }

    return {
      ...decision,
      fallback: fallback
        ? { from: "jev", reason: fallback.reason }
        : null,
    };
  };

  if (selectRouterBackend(routerPreference) === "model") {
    return runModel();
  }

  if (typeof jevRouter !== "function") {
    return runModel({ reason: "unavailable" });
  }

  let jevDecision;
  try {
    const raw = await jevRouter(task);
    if (raw?.state === "unavailable" || raw?.status === "unavailable" || raw?.available === false) {
      throw new RoutingError("unavailable", "Jev Router is unavailable");
    }
    jevDecision = normalizeRoutingDecision(raw, "jev");
  } catch (error) {
    return runModel({ reason: fallbackReason(error) });
  }

  if (isLowConfidence(jevDecision, confidenceThreshold)) {
    return runModel({ reason: "low_confidence", jevDecision });
  }

  return { ...jevDecision, fallback: null };
}
