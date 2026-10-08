# Changelog

User-visible changes are listed here. Unreleased entries do not imply a published version or release tag.

## Unreleased

### Added

- Bilingual routing simulation with an Astra / Medium baseline, Sol / Medium and explicitly overridden Luna / Max recommendations, and token-budget charts. All budgets are illustrative assumptions including coordination overhead, not measured savings or pricing estimates.

- Implicit selection guidance for new development requests, continuation rules that avoid repeated planning, and optional recurring-use instructions for AGENTS.md / CLAUDE.md. The enabled switch controls execution after selection, not guaranteed Host activation.

- English and Traditional Chinese configuration and operations guides, with workflow and configuration-precedence diagrams.

### Changed

- Shortened both READMEs into installation, quick start, commands, model allocation, and documentation entry points.
- Defaults use GPT-6 Luna / High, GPT-6.1 Sol / Medium, GPT-6.1 Sol / XHigh, and GPT-6 Astra / Medium.
- Model status distinguishes classified, unclassified, and unavailable models using Host facts and exact-id policy. Unknown models do not automatically enter routing or replace defaults.
- Host-selected Coordinator model and effort are the default allocation ceiling; `allowModelEscalation=true` explicitly permits upward allocation.
- Explicit `init`, `config`, `status`, `reset`, `verify`, and `plan` commands support setup and everyday use.

### Fixed

- Init now requires an answerable first question after inspection, continues with unresolved choices, and preserves explicit settings and scope. Fresh-session UX revalidation remains pending.
- Jev-assisted planning invokes production assessment without injected Jev decisions and preserves Agent fallback diagnostics.

Earlier development logs and acceptance history remain in the development repository; release dates and version numbers are not inferred from them.
