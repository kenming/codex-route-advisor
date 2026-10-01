# Runtime Model Discovery

## Contract

Discovery answers **availability**, not routing capability.

The provider-neutral adapter should return a Model Inventory:

```text
discoverModels({
  reason,
  cacheState,
  ageMs,
  context
})
→ {
  inventory: [
    { id, available }
  ]
}
```

A discovered model may be available while its routing capability is still unknown.
The core must not infer `family`, `tiers`, or `supportedEfforts` from the model id.

For backward compatibility, adapters/tests may still return the legacy complete
`{ catalog: [...] }` shape. That path remains supported but is not the preferred
discovery contract.

## Inventory → capability → catalog

```text
provider / host availability
        ↓
Model Inventory
        +
exact-id Capability Registry
        ↓
Resolved Routable Catalog
```

Inventory entries require only:

```text
id
available
```

Capability entries are maintained separately and require:

```text
id
family
tiers
supportedEfforts
```

Only an exact model-id capability match can classify a discovered model.
Name parsing such as `gpt-6.1-sol → sol` is not a valid capability source.

An available model without capability metadata is returned as `unclassified`
with `routable = false`. It remains visible to diagnostics/UI but is excluded
from automatic model selection.

## Cache lifecycle

Availability is cached independently in:

```text
Windows: %LOCALAPPDATA%\codex-route-advisor\model-inventory-cache.json
macOS:   ~/Library/Caches/codex-route-advisor/model-inventory-cache.json
Linux:   $XDG_CACHE_HOME/codex-route-advisor/model-inventory-cache.json
         fallback → ~/.cache/codex-route-advisor/model-inventory-cache.json
```

The inventory cache uses the same 24-hour fresh TTL and seven-day stale
eligibility as the legacy model catalog cache.

Caching Inventory rather than only a resolved catalog is intentional: if a new
model is discovered today but capability metadata is added later, the cached
inventory can be reclassified without calling discovery again.

When tests or hosts provide a custom legacy model-cache path but omit an
inventory-cache path, the inventory cache is derived beside that custom path to
keep runtime/test state isolated.

## When discovery runs

Discovery is requested for:

- missing or invalid usable cache state;
- cache expired beyond seven days;
- `catalog.forceRefresh = true`;
- `catalog.liveRefresh = true`.

A stale cache remains reusable until an explicit refresh trigger.

`catalog.clearCache` clears both the inventory cache and the applicable legacy
catalog cache. Clear alone does not imply live discovery.

## Errors

Canonical discovery errors remain:

```text
provider_unavailable
authentication_required
permission_denied
rate_limited
network_error
invalid_provider_response
unsupported
```

A refresh failure may reuse an eligible inventory cache. Expired inventory is
not used as authoritative availability.

## Host integration

Library integration uses:

```text
scripts/model-discovery.mjs
resolveModelCatalogWithDiscovery(...)
```

Preferred deterministic injection:

```json
{
  "modelDiscovery": {
    "inventory": [
      { "id": "gpt-6.1-sol", "available": true }
    ]
  },
  "modelCapabilities": [],
  "catalog": {
    "liveRefresh": true
  }
}
```

Direct `modelInventory` and `modelCapabilities` inputs are also accepted by
`scripts/route-task.mjs`.

Legacy `modelCatalog` and `modelDiscovery.catalog` remain supported for
existing integrations.

## Codex host source

The shipped Codex adapter lives in `scripts/codex-model-source.mjs`.

It invokes the current Codex CLI model-catalog diagnostic:

```text
codex debug models
```

and converts the returned host catalog to Inventory only:

```text
slug + visibility
→
id + available
```

Entries with `visibility = list` are treated as available for automatic Advisor
selection. Hidden entries remain visible in Inventory as `available = false`.

The adapter deliberately ignores advertised reasoning metadata for routing
classification. Family / tier / supported-effort routing capability remains an
exact-id Capability Registry concern.

`advise-task.mjs` and `route-task.mjs` use this adapter by default when no
explicit runtime inventory/catalog override short-circuits discovery. Direct
injection remains available for deterministic tests and host integrations.
