import test from "node:test";
import assert from "node:assert/strict";
import { classifyMainUserTurn } from "../scripts/request-classifier.mjs";

function headers(originator, metadata) {
  return {
    originator,
    "x-codex-turn-metadata": JSON.stringify(metadata),
  };
}

const common = {
  request_kind: "turn",
  agent_name: "/root",
  turn_id: "turn-1",
  root_turn_id: "turn-1",
  thread_source: "user",
};

test("classifies validated CLI root user turn with absent turn_trigger", () => {
  const result = classifyMainUserTurn(headers("codex_exec", common));
  assert.equal(result.isMainUserTurn, true);
  assert.equal(result.reason, "validated_cli_root_user_turn");
});

test("fails closed when CLI unexpectedly carries turn_trigger", () => {
  const result = classifyMainUserTurn(headers("codex_exec", { ...common, turn_trigger: "composer" }));
  assert.equal(result.isMainUserTurn, false);
  assert.equal(result.reason, "unexpected_cli_turn_trigger");
});

for (const originator of ["codex_work_desktop", "codex_vscode"]) {
  test(`classifies ${originator} composer root user turn`, () => {
    const result = classifyMainUserTurn(headers(originator, { ...common, turn_trigger: "composer" }));
    assert.equal(result.isMainUserTurn, true);
    assert.equal(result.reason, "validated_composer_root_user_turn");
  });

  test(`rejects ${originator} thread-title auxiliary turn`, () => {
    const result = classifyMainUserTurn(headers(originator, {
      ...common,
      thread_source: "thread_title",
      turn_trigger: "thread_title",
    }));
    assert.equal(result.isMainUserTurn, false);
    assert.equal(result.reason, "common_identity_mismatch");
  });
}

test("rejects malformed turn metadata", () => {
  const result = classifyMainUserTurn({
    originator: "codex_vscode",
    "x-codex-turn-metadata": "{not-json",
  });
  assert.equal(result.isMainUserTurn, false);
  assert.equal(result.reason, "invalid_turn_metadata");
});

test("rejects missing turn metadata", () => {
  const result = classifyMainUserTurn({ originator: "codex_vscode" });
  assert.equal(result.isMainUserTurn, false);
  assert.equal(result.reason, "missing_turn_metadata");
});

test("rejects unknown originator", () => {
  const result = classifyMainUserTurn(headers("future_host", { ...common, turn_trigger: "composer" }));
  assert.equal(result.isMainUserTurn, false);
  assert.equal(result.reason, "unsupported_originator");
});

test("rejects non-root and mismatched root turns", () => {
  assert.equal(classifyMainUserTurn(headers("codex_vscode", {
    ...common,
    agent_name: "/review",
    turn_trigger: "composer",
  })).isMainUserTurn, false);

  assert.equal(classifyMainUserTurn(headers("codex_vscode", {
    ...common,
    root_turn_id: "turn-2",
    turn_trigger: "composer",
  })).isMainUserTurn, false);
});
