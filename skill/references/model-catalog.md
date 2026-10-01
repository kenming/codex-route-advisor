# Runtime Model Catalog

## Responsibility

The routable catalog is now a **resolved view**, not the discovery payload.

```text
Model Inventory
+ Capability Registry
→ Resolved Routable Catalog
```

Discovery answers whether a concrete model exists and is available.
Capability classification answers how that exact model may be routed.

The final catalog entry contract remains:

```text
id
family
tiers
supportedEfforts
available
```

This preserves the existing resolver/routing contract.

## Capability Registry

Capability entries use exact model ids:

```text
id
family
tiers
supportedEfforts
```

The built-in exact-id registry lives with the Skill implementation and is
release-managed. Runtime/host capability entries may be supplied explicitly and
override built-in entries with the same id.

The registry must not infer capability from model naming. A model such as
`gpt-6.1-sol` is not treated as Sol merely because the id contains `sol`.

A discovered model with no exact capability entry is reported as:

```json
{
  "id": "gpt-6.1-sol",
  "available": true,
  "capabilityStatus": "unclassified",
  "routable": false
}
```

It is visible but excluded from automatic routing.

## Availability cache

Preferred discovery state is cached as Inventory:

```text
Windows: %LOCALAPPDATA%\codex-route-advisor\model-inventory-cache.json
macOS:   ~/Library/Caches/codex-route-advisor/model-inventory-cache.json
Linux:   $XDG_CACHE_HOME/codex-route-advisor/model-inventory-cache.json
         fallback → ~/.cache/codex-route-advisor/model-inventory-cache.json
```

Schema: `references/model-inventory-cache.schema.json`.

Fresh TTL is 24 hours. Cache may be reused as stale fallback for at most seven
days.

Because the cache stores availability separately, a later capability-registry
update can classify an already-discovered model without requiring rediscovery.

## Legacy complete catalog compatibility

The previous complete runtime-catalog path remains supported:

```text
runtime catalog
> legacy runtime catalog cache
> built-in family fallback
```

Legacy catalog cache:

```text
Windows: %LOCALAPPDATA%\codex-route-advisor\model-cache.json
macOS:   ~/Library/Caches/codex-route-advisor/model-cache.json
Linux:   $XDG_CACHE_HOME/codex-route-advisor/model-cache.json
         fallback → ~/.cache/codex-route-advisor/model-cache.json
```

Schema: `references/model-cache.schema.json`.

This path exists for backward compatibility with hosts/tests that already
provide fully classified catalog entries. New provider discovery should prefer
Inventory.

## Diagnostics

Resolved catalog entries are still checked against built-in family-tier policy.
Runtime/built-in discrepancies are diagnostics and do not silently rewrite
routing semantics.

Unclassified inventory is a separate state from a routing discrepancy:
- discovered + classified → may enter the routable catalog;
- discovered + unclassified → visible, non-routable;
- classified + `available: false` → remains non-selectable.

## Host integration

Normal Codex execution uses `scripts/codex-model-source.mjs` to obtain the
current host model Inventory through `codex debug models`. Both
`scripts/advise-task.mjs` and `scripts/route-task.mjs` use that source by
default.

Deterministic callers may still supply explicit runtime facts. `scripts/route-task.mjs` accepts:

- `modelInventory` — direct availability facts;
- `modelCapabilities` — exact-id capability registry overlay;
- `modelDiscovery.inventory` — preferred discovery result;
- legacy `modelCatalog` / `modelDiscovery.catalog`.

Optional lifecycle controls remain `catalog.forceRefresh`,
`catalog.clearCache`, and `catalog.liveRefresh`.

`modelInventoryCachePath` can override the inventory cache location.
`modelCachePath` continues to address the legacy catalog cache.

Catalog lifecycle affects model availability/capability resolution only. It does
not dispatch Advisor or Executor work.
