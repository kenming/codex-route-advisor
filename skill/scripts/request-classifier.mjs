const SUPPORTED_ORIGINATORS = new Set([
  "codex_exec",
  "codex_work_desktop",
  "codex_vscode",
]);

function parseTurnMetadata(headers) {
  const raw = headers?.["x-codex-turn-metadata"];
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "missing_turn_metadata", metadata: null };
  }

  try {
    const metadata = JSON.parse(raw);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return { ok: false, reason: "invalid_turn_metadata", metadata: null };
    }
    return { ok: true, reason: null, metadata };
  } catch {
    return { ok: false, reason: "invalid_turn_metadata", metadata: null };
  }
}

export function classifyMainUserTurn(headers) {
  const originator = headers?.originator;
  if (typeof originator !== "string" || !SUPPORTED_ORIGINATORS.has(originator)) {
    return { isMainUserTurn: false, reason: "unsupported_originator", originator: originator ?? null, metadata: null };
  }

  const parsed = parseTurnMetadata(headers);
  if (!parsed.ok) {
    return { isMainUserTurn: false, reason: parsed.reason, originator, metadata: null };
  }

  const metadata = parsed.metadata;
  const commonMatch = metadata.request_kind === "turn"
    && metadata.agent_name === "/root"
    && typeof metadata.turn_id === "string"
    && metadata.turn_id.length > 0
    && metadata.turn_id === metadata.root_turn_id
    && metadata.thread_source === "user";

  if (!commonMatch) {
    return { isMainUserTurn: false, reason: "common_identity_mismatch", originator, metadata };
  }

  if (originator === "codex_exec") {
    if (Object.hasOwn(metadata, "turn_trigger")) {
      return { isMainUserTurn: false, reason: "unexpected_cli_turn_trigger", originator, metadata };
    }
    return { isMainUserTurn: true, reason: "validated_cli_root_user_turn", originator, metadata };
  }

  if (metadata.turn_trigger !== "composer") {
    return { isMainUserTurn: false, reason: "non_composer_turn", originator, metadata };
  }

  return { isMainUserTurn: true, reason: "validated_composer_root_user_turn", originator, metadata };
}
