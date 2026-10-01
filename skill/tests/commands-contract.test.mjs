import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const commandsFile = fileURLToPath(
  new URL("../references/commands.md", import.meta.url),
);
const skillFile = fileURLToPath(new URL("../SKILL.md", import.meta.url));
const operationsFile = fileURLToPath(
  new URL("../references/operations.md", import.meta.url),
);

async function docs() {
  const [commands, skill, operations] = await Promise.all([
    readFile(commandsFile, "utf8"),
    readFile(skillFile, "utf8"),
    readFile(operationsFile, "utf8"),
  ]);
  return { commands, skill, operations };
}

test("Skill exposes the supported invocation command surface", async () => {
  const { commands, skill } = await docs();
  const invocations = [
    "$codex-route-advisor init",
    "$codex-route-advisor config",
    "$codex-route-advisor status",
    "$codex-route-advisor reset",
    "$codex-route-advisor verify",
    "$codex-route-advisor plan <task>",
  ];

  for (const invocation of invocations) {
    assert.ok(commands.includes(invocation), `commands.md missing ${invocation}`);
    assert.ok(skill.includes(invocation), `SKILL.md missing ${invocation}`);
  }

  assert.match(skill, /references\/commands\.md/);
  assert.match(commands, /Skill invocation commands/);
  assert.match(commands, /not a separate shell CLI/);
});

test("init and reset keep their safety boundaries", async () => {
  const { commands, operations } = await docs();

  assert.match(commands, /allowModelEscalation=false/);
  assert.match(commands, /must not make a Jev live API call/i);
  assert.match(commands, /requires explicit confirmation/i);
  assert.match(commands, /does not delete the model cache or execution traces/i);

  assert.match(operations, /guided update/);
  assert.match(operations, /不得默認 `reset all`/);
});

test("verify and plan commands are explicit and non-persistent by default", async () => {
  const { commands, operations } = await docs();

  assert.match(commands, /verify jev-live/);
  assert.match(commands, /Only `verify jev-live`/);
  assert.match(commands, /Session-only.*executionMode=plan/i);
  assert.match(commands, /Stop at the planning boundary/i);

  assert.match(operations, /local\/non-destructive verification/);
  assert.match(operations, /不把 `plan` 持久化/);
});
