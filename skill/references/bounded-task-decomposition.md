# Bounded Task Decomposition

A **Bounded Task** is the smallest unit that deserves an independent routing decision.

## Split triggers

Split a candidate task only when at least one child would materially differ in:
- required capability;
- reasoning depth;
- primary tool set;
- dependency ordering;
- validation method;
- risk / blast radius.

Do not split merely because implementation contains several mechanical steps.

## Stop rule

Stop decomposition when likely child steps:
- need the same routing tier / reasoning profile;
- use the same core tools;
- share the same local execution context;
- participate in one validation cycle;
- have no independent dependency gate.

A simple edit plus its focused test normally remains one bounded task.

A downstream conditional failure branch does not change that stop rule. For:

```text
implement X
→ focused test X
→ diagnose only if the focused test fails
```

prefer two bounded tasks:
- implementation + focused test as one task;
- failure diagnosis as a conditional task depending on the first task's failure outcome.

Do not split the implementation from its focused verification merely to manufacture the conditional gate.

## Reviewer-gate test

A task boundary is strong when a reviewer could accept one task and reject its neighbor
without invalidating the accepted task's deliverable.

If that is not true, keep the work together unless capability, tool, validation,
dependency, or risk routing materially differs.

## Execution-context test

Each bounded task must give a fresh worker enough information to act from:
- goal;
- relevant context / inputs;
- dependency outputs;
- expected deliverable;
- acceptance / validation criteria.

A task that requires the coordinator's full conversation history is not well bounded.

## Agent bridge authoring normalization

The Agent-to-script bridge accepts a small set of shorthand forms to reduce avoidable schema retries while preserving one canonical bounded-task contract:

- string task `context` normalizes to `{ "summary": "..." }`;
- string task `acceptance` normalizes to `["..."]`;
- top-level string `context` / `constraints` normalize to summary objects.

After normalization, bounded tasks still require object `context` and a non-empty string-array `acceptance`. Other malformed fields remain errors; this is not general coercion.

## Dependency and parallel safety

Represent dependencies explicitly.

Recommend parallel work only when:
- prerequisites are already satisfied;
- there is no unresolved interface dependency;
- workers do not contend on the same mutable implementation surface;
- each task has independent validation.

After decomposition, perform one explicit parallel-safety pass over tasks on the same dependency frontier. When two or more tasks satisfy all four conditions, record them in `parallelGroups`; do not leave parallelism implicit only in `boundaryReason` or prose. A group is an executable scheduling recommendation, not merely documentation.

Otherwise serialize the tasks.

## One-pass v1 rule

v1 performs one primary decomposition pass.
Do not recursively expand every bounded task.
Merge obvious setup, scaffolding, configuration, implementation, and focused verification
when they share the same routing decision and validation loop.

## Examples

### Correct: one bounded task

Goal: rename a configuration field and update its focused unit test.

Why one task:
- same code context;
- same capability and tools;
- one dependency gate;
- one focused test cycle.

### Correct: separate validation boundary

T1: implement a product-list UI.
T2: validate the UI with Playwright, depends on T1.
T3: diagnose and fix validation failures, depends on T2 and runs only on T2 failure.

The validation and diagnosis tasks justify distinct tool / reasoning / conditional boundaries.

### Correct: parallel candidates

T1: implement a frontend against a fixed API contract.
T2: implement the backend behind that same fixed contract.

They may be parallel only when neither task mutates the other's implementation surface
and both can be validated independently.

### Over-decomposed

Do not split one local code change into:
1. open file;
2. edit function;
3. run unit test;
4. inspect test output.

Those are mechanical steps inside one bounded task because routing, context, tools,
dependency gate, and validation cycle are shared.
