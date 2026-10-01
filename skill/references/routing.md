# Per-task Routing

Routing happens **after** bounded-task decomposition.

```text
bounded task
→ Jev or Agent assessment
→ tier
→ model / reasoning effort
→ Dispatch Plan task
```

The public Advisor contract uses only these assessment sources:

```text
jev
agent
```

The existing `routing.mjs` primitive internally calls the fallback backend `model` for historical compatibility.
At the Dispatch Plan boundary, `backend=model` is normalized to `assessment.source=agent`.

## Taxonomy

Only four tiers are valid:

```text
fast
balanced
strong
long
```

### Fast

Use for:
- explicit, local, low-ambiguity work;
- established patterns;
- deterministic inspection or validation;
- CRUD / small focused changes when little judgment is required.

Default: Luna High.
### Balanced

Use for:
- ordinary engineering judgment;
- bounded design choices or trade-offs;
- implementation where the goal and acceptance criteria are known;
- work that does not require unknown-root-cause diagnosis.

Default: Sol Medium.

### Strong

Use for:
- unknown root cause;
- competing hypotheses;
- cross-subsystem diagnosis;
- unusually strict or deep technical verification.

Default: Sol XHigh.

### Long

Use for:
- long-horizon or broad-context work;
- major redesign / migration;
- rollout / compatibility / rollback planning;
- sustained framing across a large system.

Default: Astra Medium.

`long` is not a generic upgrade from `strong`.

## Assessment contract

Jev and Agent fallback use the same semantic fields:

```json
{
  "tier": "strong",
  "confidence": 0.91,
  "reason": "unknown root cause requires hypothesis testing"
}
```

Optional normalized signals:
- `taskComplexity`
- `reasoningRequired`
- `toolComplexity`

All signal values are in `0..1`.
## Confidence policy

Default threshold: `0.75`.

```text
Jev >= threshold
→ use Jev

Jev unavailable / error / low confidence
→ use Agent fallback

Agent < threshold
→ clarification_required
```

Low confidence is not a reason to automatically escalate capability.

## Per-task isolation

Routing is independent per bounded task.

A request such as:

```text
T1 implementation
T2 deterministic browser validation
T3 unknown failure diagnosis
```

may legitimately produce:

```text
T1 → balanced
T2 → fast
T3 → strong
```

Do not elevate T1 or T2 merely because T3 is difficult.

## Fallback diagnostics

The internal routing primitive may preserve:

```json
{
  "fallback": {
    "from": "jev",
    "reason": "low_confidence"
  }
}
```

This is diagnostic metadata.
Normal user-facing output only needs `assessment.source`, recommendation, dependencies and short rationale unless `explain` is requested.
## Resolution

After tier selection, `resolver.mjs` applies the configured profile.

Preference precedence:

```text
Session > Workspace > Global > Skill default
```

The resolver may use a supplied runtime model catalog.
Without an authoritative catalog, an abstract family recommendation such as `sol` or `luna` is valid and availability remains unchecked internally.

## Explicit model override

The historical resolver still supports explicit model / effort overrides for compatibility.
An override:
1. bypasses automatic task classification;
2. validates supported effort;
3. resolves a valid tier;
4. validates runtime availability when a catalog is supplied;
5. never silently substitutes an unavailable explicitly requested concrete model.

This is a per-task routing primitive, not a runtime dispatch mechanism.

## Advisor output boundary

`advise-task.mjs` converts the effective routing decision into:

```json
{
  "assessment": {
    "source": "agent",
    "confidence": 0.9
  },
  "recommendation": {
    "tier": "balanced",
    "model": "sol",
    "effort": "medium"
  }
}
```

No `dispatchStatus=dispatched` claim is produced.
The coordinator decides how to execute or delegate the plan.
