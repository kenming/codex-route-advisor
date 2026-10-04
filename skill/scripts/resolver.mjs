#!/usr/bin/env node

import { normalizeModelCatalog } from "./model-catalog.mjs";
import { BUILTIN_MODEL_CAPABILITIES } from "./model-inventory.mjs";
import {
  DEFAULT_ROUTING_PREFERENCES,
  EFFORTS,
  MODEL_FAMILIES,
  ROUTING_TIERS,
  RoutingError,
  isPlainObject,
} from "./routing.mjs";

function descriptorForReference(reference, catalog, catalogSupplied) {
  if (typeof reference !== "string" || !reference.trim()) {
    throw new RoutingError("unknown_model", "Model reference must be a non-empty string", {
      field: "model",
    });
  }

  const normalized = reference.trim();
  const family = MODEL_FAMILIES[normalized.toLowerCase()];
  if (family) {
    return {
      id: null,
      family: family.family,
      tiers: [...family.tiers],
      supportedEfforts: null,
      abstractFamily: true,
    };
  }

  const exact = catalog.find((entry) => entry.id === normalized);
  if (exact) return { ...exact, abstractFamily: false };

  const builtInCapability = BUILTIN_MODEL_CAPABILITIES.find(
    (entry) => entry.id === normalized,
  );
  if (builtInCapability) {
    return {
      id: builtInCapability.id,
      family: builtInCapability.family,
      tiers: [...builtInCapability.tiers],
      supportedEfforts: null,
      available: false,
      abstractFamily: false,
      unchecked: !catalogSupplied,
    };
  }

  if (!catalogSupplied) {
    return {
      id: normalized,
      family: null,
      tiers: [],
      supportedEfforts: null,
      abstractFamily: false,
      unchecked: true,
    };
  }

  throw new RoutingError("unknown_model", `Unknown concrete model: ${normalized}`, {
    field: "model",
    model: normalized,
  });
}

function validateEffort(effort) {
  if (!EFFORTS.includes(effort)) {
    throw new RoutingError("unsupported_effort", `Unsupported reasoning effort: ${effort}`, {
      field: "effort",
      effort,
    });
  }
}

function validateEffortForDescriptor(descriptor, effort, details = {}) {
  if (descriptor.family === "luna" && !["high", "xhigh", "max"].includes(effort)) {
    throw new RoutingError(
      "invalid_model_effort_combination",
      "Luna family requires High or greater in this Skill policy",
      { ...details, model: descriptor.id ?? descriptor.family, effort },
    );
  }

  if (
    descriptor.supportedEfforts
    && !descriptor.supportedEfforts.includes(effort)
  ) {
    throw new RoutingError(
      "invalid_model_effort_combination",
      `Model ${descriptor.id ?? descriptor.family} does not support effort ${effort}`,
      { ...details, model: descriptor.id ?? descriptor.family, effort },
    );
  }
}

function validateDescriptorForTier(descriptor, tier, effort) {
  if (!ROUTING_TIERS.includes(tier)) {
    throw new RoutingError("invalid_response", `Unsupported routing tier: ${tier}`, { tier });
  }
  if (descriptor.tiers.length > 0 && !descriptor.tiers.includes(tier)) {
    throw new RoutingError(
      "invalid_model_tier_combination",
      `Model ${descriptor.id ?? descriptor.family} is not compatible with tier ${tier}`,
      { tier, model: descriptor.id ?? descriptor.family },
    );
  }
  validateEffortForDescriptor(descriptor, effort, { tier });
}

function candidateSupports(candidate, tier, effort) {
  if (!candidate?.available) return false;
  if (candidate.tiers.length > 0 && !candidate.tiers.includes(tier)) return false;
  if (candidate.supportedEfforts && !candidate.supportedEfforts.includes(effort)) return false;
  if (candidate.family === "luna" && !["high", "xhigh", "max"].includes(effort)) return false;
  return true;
}

function candidateSupportsEffort(candidate, effort) {
  if (!candidate?.available) return false;
  if (candidate.supportedEfforts && !candidate.supportedEfforts.includes(effort)) return false;
  if (candidate.family === "luna" && !["high", "xhigh", "max"].includes(effort)) return false;
  return true;
}

function findReplacement(catalog, tier, effort, preferredFamily) {
  const sameFamily = catalog.find(
    (candidate) => candidate.family === preferredFamily && candidateSupports(candidate, tier, effort),
  );
  if (sameFamily) return sameFamily;
  return catalog.find((candidate) => candidateSupports(candidate, tier, effort)) ?? null;
}

function preferenceSourceForTier(sources, tier) {
  return {
    model: sources?.[tier]?.model ?? "unknown",
    reasoningEffort: sources?.[tier]?.effort ?? "unknown",
  };
}

const TIER_RANK = Object.freeze({ fast: 0, balanced: 1, strong: 2, long: 3 });
const EFFORT_RANK = Object.freeze(Object.fromEntries(EFFORTS.map((effort, index) => [effort, index])));

function familyFloorRank(descriptor) {
  if (!descriptor?.tiers?.length) return null;
  return Math.min(...descriptor.tiers.map((tier) => TIER_RANK[tier]));
}

function normalizeCoordinatorProfile(profile, catalog, catalogSupplied) {
  if (!isPlainObject(profile)) {
    throw new RoutingError(
      "coordinator_profile_required",
      "coordinatorProfile with model and effort is required when model escalation is disabled",
      { field: "coordinatorProfile" },
    );
  }
  if (typeof profile.model !== "string" || !profile.model.trim()) {
    throw new RoutingError("invalid_schema", "coordinatorProfile.model must be a non-empty string", {
      field: "coordinatorProfile.model",
    });
  }
  validateEffort(profile.effort);
  const descriptor = descriptorForReference(profile.model, catalog, catalogSupplied);
  validateEffortForDescriptor(descriptor, profile.effort, { field: "coordinatorProfile.effort" });
  return { descriptor, model: descriptor.id ?? descriptor.family, effort: profile.effort };
}

export function applyModelEscalationPolicy({
  recommendation,
  coordinatorProfile,
  allowModelEscalation = false,
  modelCatalog,
} = {}) {
  if (allowModelEscalation) {
    return { ...recommendation, escalationConstrained: false };
  }
  if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) {
    throw new RoutingError("invalid_response", "Resolved recommendation is required");
  }

  const catalogSupplied = modelCatalog !== undefined;
  const catalog = catalogSupplied ? normalizeModelCatalog(modelCatalog) : [];
  const coordinator = normalizeCoordinatorProfile(coordinatorProfile, catalog, catalogSupplied);
  const recommendedDescriptor = descriptorForReference(
    recommendation.model,
    catalog,
    catalogSupplied,
  );
  validateEffort(recommendation.reasoningEffort);

  const sameFamily = Boolean(
    coordinator.descriptor.family
    && recommendedDescriptor.family
    && coordinator.descriptor.family === recommendedDescriptor.family
  );
  const sameModel = coordinator.model === (recommendedDescriptor.id ?? recommendedDescriptor.family);
  const coordinatorFamilyRank = familyFloorRank(coordinator.descriptor);
  const recommendedFamilyRank = familyFloorRank(recommendedDescriptor);

  let escalates;
  if (sameFamily || sameModel) {
    escalates = EFFORT_RANK[recommendation.reasoningEffort] > EFFORT_RANK[coordinator.effort];
  } else if (coordinatorFamilyRank !== null && recommendedFamilyRank !== null) {
    escalates = recommendedFamilyRank > coordinatorFamilyRank;
  } else {
    throw new RoutingError(
      "model_escalation_comparison_unavailable",
      "Cannot compare the recommended model with the coordinator profile",
      {
        field: "coordinatorProfile.model",
        coordinatorModel: coordinator.model,
        recommendedModel: recommendation.model,
      },
    );
  }

  if (!escalates) {
    return { ...recommendation, escalationConstrained: false };
  }

  return {
    ...recommendation,
    model: coordinator.model,
    reasoningEffort: coordinator.effort,
    escalationConstrained: true,
    preferredModel: recommendation.model,
    preferredReasoningEffort: recommendation.reasoningEffort,
    escalationConstraint: "model_escalation_disabled",
  };
}

function resolveExplicitTier({ requestedTier, descriptor, effort }) {
  if (requestedTier !== undefined) {
    if (!ROUTING_TIERS.includes(requestedTier)) {
      throw new RoutingError(
        "unknown_tier",
        `Unsupported explicit override tier: ${requestedTier}`,
        { tier: requestedTier, field: "explicitOverride.tier" },
      );
    }
    validateDescriptorForTier(descriptor, requestedTier, effort);
    return requestedTier;
  }

  if (descriptor.tiers.length === 1) {
    return descriptor.tiers[0];
  }

  const profileMatches = ROUTING_TIERS.filter((tier) => {
    const defaultModel = DEFAULT_ROUTING_PREFERENCES[tier].model;
    const defaultCapability = BUILTIN_MODEL_CAPABILITIES.find(
      (entry) => entry.id === defaultModel,
    );
    const modelMatches = (
      defaultModel === descriptor.id
      || defaultModel === descriptor.family
      || (
        defaultCapability?.family !== undefined
        && defaultCapability.family === descriptor.family
      )
    );

    return (
      modelMatches
      && DEFAULT_ROUTING_PREFERENCES[tier].effort === effort
      && (descriptor.tiers.length === 0 || descriptor.tiers.includes(tier))
    );
  });

  if (profileMatches.length === 1) {
    return profileMatches[0];
  }

  throw new RoutingError(
    "explicit_override_tier_required",
    "Explicit override tier cannot be inferred uniquely; provide explicitOverride.tier",
    {
      model: descriptor.id ?? descriptor.family,
      effort,
      candidateTiers: [...descriptor.tiers],
      field: "explicitOverride.tier",
    },
  );
}

export function resolveRoutingDecision({
  decision,
  preferences,
  sources,
  modelCatalog,
} = {}) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new RoutingError("invalid_response", "Routing decision is required");
  }
  if (!ROUTING_TIERS.includes(decision.tier)) {
    throw new RoutingError("invalid_response", `Unsupported routing tier: ${decision.tier}`, {
      tier: decision.tier,
    });
  }

  const preference = preferences?.[decision.tier];
  if (!preference) {
    throw new RoutingError("unknown_tier", `No preference for tier ${decision.tier}`, {
      tier: decision.tier,
    });
  }

  const effort = preference.effort;
  validateEffort(effort);

  const catalogSupplied = modelCatalog !== undefined;
  const catalog = catalogSupplied ? normalizeModelCatalog(modelCatalog) : [];
  const descriptor = descriptorForReference(preference.model, catalog, catalogSupplied);
  validateDescriptorForTier(descriptor, decision.tier, effort);

  let selected = descriptor;
  let availability = catalogSupplied ? "validated" : "unchecked";
  let modelFallback = null;

  if (catalogSupplied) {
    if (descriptor.abstractFamily) {
      const preferred = catalog.find(
        (candidate) => (
          candidate.family === descriptor.family
          && candidateSupports(candidate, decision.tier, effort)
        ),
      );

      if (preferred) {
        selected = preferred;
      } else {
        const replacement = findReplacement(catalog, decision.tier, effort, descriptor.family);
        if (!replacement) {
          throw new RoutingError(
            "model_unavailable",
            `No available model satisfies tier ${decision.tier} and effort ${effort}`,
            { tier: decision.tier, effort },
          );
        }
        selected = replacement;
        modelFallback = {
          reason: "model_unavailable",
          from: descriptor.family,
          to: replacement.id,
        };
      }
    } else {
      const actual = catalog.find((candidate) => candidate.id === descriptor.id);
      if (!candidateSupports(actual ?? descriptor, decision.tier, effort)) {
        const replacement = findReplacement(catalog, decision.tier, effort, descriptor.family);
        if (!replacement) {
          throw new RoutingError(
            "model_unavailable",
            `Preferred model ${descriptor.id} is unavailable and no equivalent replacement exists`,
            { tier: decision.tier, model: descriptor.id },
          );
        }
        selected = replacement;
        modelFallback = {
          reason: "model_unavailable",
          from: descriptor.id,
          to: replacement.id,
        };
      } else {
        selected = actual;
      }
    }
  }

  return {
    tier: decision.tier,
    model: selected.id ?? selected.family,
    modelFamily: selected.family ?? null,
    reasoningEffort: effort,
    decisionSource: decision.backend,
    confidence: decision.confidence,
    reason: decision.reason,
    preferenceSource: preferenceSourceForTier(sources, decision.tier),
    fallback: decision.fallback ?? null,
    modelFallback,
    dispatchStatus: "not_dispatched",
    availability,
  };
}

export function resolveExplicitOverride({
  override,
  modelCatalog,
} = {}) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    throw new RoutingError("invalid_schema", "explicitOverride must be an object", {
      field: "explicitOverride",
    });
  }

  const effort = override.reasoningEffort ?? override.effort;
  validateEffort(effort);
  const requestedTier = override.tier;
  if (requestedTier !== undefined && !ROUTING_TIERS.includes(requestedTier)) {
    throw new RoutingError(
      "unknown_tier",
      `Unsupported explicit override tier: ${requestedTier}`,
      { tier: requestedTier, field: "explicitOverride.tier" },
    );
  }

  const catalogSupplied = modelCatalog !== undefined;
  const catalog = catalogSupplied ? normalizeModelCatalog(modelCatalog) : [];
  const descriptor = descriptorForReference(override.model, catalog, catalogSupplied);
  validateEffortForDescriptor(descriptor, effort);

  const tier = resolveExplicitTier({
    requestedTier,
    descriptor,
    effort,
  });

  let selected = descriptor;
  let availability = catalogSupplied ? "validated" : "unchecked";

  if (catalogSupplied) {
    if (descriptor.abstractFamily) {
      const preferred = catalog.find(
        (candidate) => (
          candidate.family === descriptor.family
          && candidateSupports(candidate, tier, effort)
        ),
      );
      if (!preferred) {
        throw new RoutingError(
          "model_unavailable",
          `No available ${descriptor.family} model supports effort ${effort}`,
          { model: descriptor.family, effort },
        );
      }
      selected = preferred;
    } else {
      const actual = catalog.find((candidate) => candidate.id === descriptor.id);
      if (!candidateSupports(actual, tier, effort)) {
        throw new RoutingError(
          "model_unavailable",
          `Explicit model ${descriptor.id} is unavailable or does not support effort ${effort}`,
          { model: descriptor.id, effort, explicitOverride: true },
        );
      }
      selected = actual;
    }
  }

  return {
    tier,
    model: selected.id ?? selected.family,
    modelFamily: selected.family ?? null,
    reasoningEffort: effort,
    decisionSource: "user_override",
    confidence: null,
    reason: "Explicit user model override",
    preferenceSource: "user_override",
    fallback: null,
    modelFallback: null,
    dispatchStatus: "not_dispatched",
    availability,
  };
}
