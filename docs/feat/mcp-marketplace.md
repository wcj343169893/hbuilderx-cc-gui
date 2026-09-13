# MCP Marketplace – Integration & State

> Status: **implemented** (PR against `upstream/feature/v0.4.6`)
> Branch: `feature/mcp-marketplace`
>
> Architecture principle: **all discovery/mapping logic in the Java backend; the
> webview only displays dialogs and previews.**

This document describes **where** the MCP Marketplace hooks into Settings and
**what** is implemented.

---

## 1. Entry point in the UI (Settings)

| Step | File |
| --- | --- |
| Sidebar item `mcp` | `webview/src/components/settings/SettingsSidebar/index.tsx` |
| Routing to the section | `webview/src/components/settings/PlaceholderSection/index.tsx` (`type === 'mcp'` → `McpSettingsSection`) |
| The MCP section itself | `webview/src/components/mcp/McpSettingsSection.tsx` |

The `mcp` tab is a `SettingsTab` and is routed through `PlaceholderSection` to
`McpSettingsSection`.

---

## 2. The integration hook

The add-button dropdown in `McpSettingsSection.tsx` exposes two new actions:

- **Add from MCP market** → `handleAddFromMarket` opens `McpMarketplaceDialog`.
- **Import from GitHub Copilot** → `handleImportFromCopilot` opens `McpImportDialog`.

Both dialogs persist through the existing add path (`add_${prefix}mcp_server`,
via `handleSaveServer` / `handleImportServers`); no new persistence path is introduced.

---

## 3. Architecture

### 3.1 Java backend (logic only, package `mcp/marketplace` + `mcp/importer`)

| File | Responsibility |
| --- | --- |
| `handler/marketplace/McpMarketplaceHandler.java` | Bridge handler: `get_mcp_marketplace_sources`, `search_mcp_marketplace` → `window.updateMcpMarketplace*` |
| `mcp/marketplace/McpMarketplaceService.java` | Orchestrates sources: load, dedupe, search/filter, sort (official → installable → name), cap 250 |
| `mcp/marketplace/McpMarketplaceSource.java` | Source model + `defaults()` (see 3.3) |
| `mcp/marketplace/BuiltInMcpMarketplaceClient.java` | The curated presets as a built-in source |
| `mcp/marketplace/RegistryMarketplaceClient.java` | MCP Registry v0.1 client (cursor pagination) |
| `mcp/marketplace/GitHubOrgMarketplaceClient.java` | GitHub org repos (star-sorted, paginated) |
| `mcp/marketplace/McpRegistryEntryMapper.java` | Normalizes registry/GitHub JSON → entries + install options |
| `mcp/marketplace/McpMarketplaceHttpClient.java` | HTTP GET + on-disk cache (1 h TTL, stale fallback, response size cap) |
| `mcp/importer/McpServerImportService.java` | Parses a GitHub Copilot config (root key `servers`) → internal server objects |
| `handler/importer/McpServerImportHandler.java` | Bridge handler for Copilot parse/preview |
| `ui/ChatWindowDelegate.java` | Registers the new handlers |

### 3.2 Webview (display only)

- `components/mcp/McpMarketplaceDialog.tsx` – browser with search, **source dropdown**,
  list, detail panel, install-option selection and a config preview before adding.
- `components/mcp/McpImportDialog.tsx` – paste a Copilot config, request a preview from
  the backend, resolve id collisions, and import.
- `components/mcp/ServerToolsPanel.tsx` – shows the concrete backend error under "Load failed".
- `McpSettingsSection.tsx`, `types/mcp.ts`, `global.d.ts`, `styles/less/components/mcp.less`,
  `i18n/locales/*.json`.

The pre-existing `McpPresetDialog` is left untouched; everything is additive.

### 3.3 Sources (separated, selectable in the dropdown) – `McpMarketplaceSource.defaults()`

| id | Name | Type | URL |
| --- | --- | --- | --- |
| `built-in` | Built-in Presets | `BUILT_IN` | (local) |
| `official-registry` | Official MCP Registry | `REGISTRY` | `registry.modelcontextprotocol.io` |
| `github-mcp-registry` | GitHub MCP Registry | `REGISTRY` | `api.mcp.github.com` |
| `official-github-org` | MCP Official GitHub Org | `GITHUB_ORG` | `github.com/modelcontextprotocol` |

Plus the pseudo-source **"All sources"** (`all`), which searches across all of them.

---

## 4. Implemented details

### 4.1 Source-selection persistence

`selectedSourceId` is initialized from `localStorage` (`readPreferredSourceId`) and
written back on every change (`rememberPreferredSourceId`, key
`codriver.mcp.marketplace.lastSourceId`). If the stored source no longer exists, the
dialog falls back to `built-in`. The Java layer holds no view state.

### 4.2 i18n

All dialog strings go through `t('mcp.market.*')` / `t('mcp.import.*')`; keys exist in
all 10 locales (`webview/src/i18n/locales/*.json`).

### 4.3 Registry schema (v0.1)

Both `official-registry` and `github-mcp-registry` return the wrapped envelope
`{ server, _meta }` with `metadata.nextCursor`. `McpRegistryEntryMapper` unwraps the
`server` object and renders install options from `packages[]` including `runtimeHint`,
`runtimeArguments`, `packageArguments` (positional/named), `environmentVariables` and
`transport.type`; `{placeholder}` values are preserved. Covered by
`McpRegistryEntryMapperTest`.

### 4.4 GitHub Copilot import

`McpServerImportService` maps the Copilot format (root key `servers`) into the same
internal server entries as a manual add: it merges `requestInit.headers` + `headers`
(dropping null values), infers `type` (command → stdio, `/sse` URL → sse, else http),
preserves `command`/`args`/`env`/`url`/`type`/`x-metadata`, and renames colliding ids
instead of overwriting. The dialog previews the full spec before saving. Covered by
`McpServerImportServiceTest`.

### 4.5 Security hardening

- **External links** (`McpMarketplaceDialog`) are rendered only when the URL scheme is
  `http`/`https` (`isSafeHttpUrl`) and always carry `target="_blank" rel="noopener noreferrer"`,
  preventing `javascript:`-scheme execution in the JCEF webview.
- **Command allowlist** (`McpRegistryEntryMapper`): for known registry types a
  non-allowlisted `runtimeHint` is ignored in favour of the canonical runner; for unknown
  types the command is honoured but marked `unverified-command`. Risky install options
  (`local-command` / `container-command` / `unverified-command`) render a prominent
  warning banner before the user adds them.
- **`official` badge** is trusted only from the outer registry `_meta` and only when it
  carries structured metadata (not mere key presence).
- **`GITHUB_TOKEN`** is sent only to an exact allowlist of GitHub hosts.
- **Response size cap** (10 MB) in `McpMarketplaceHttpClient` guards against
  memory-exhaustion from a hostile source.

> Later polish: an "installed" badge (diff against `servers` from `useServerData`),
> secret entry via a pre-filled `McpServerDialog` for placeholder entries, and
> Codex-specific mapping (`CodexMcpServerSpec`: `http_headers`, `bearer_token_env_var`).
> The interactive GUI smoke test in the sandbox IDE (Claude **and** Codex) is still open.

---

## 5. "Official" in the MCP context

MCP is an open standard adopted by both Anthropic (Claude) and OpenAI (Codex/ChatGPT)
as *clients* — this plugin is multi-provider anyway (`apps: { claude, codex, gemini }`).
There are therefore no competing "Anthropic" vs. "OpenAI" registries; "official" here
means the **neutral** source of the MCP project:

| Source | Kind | Role |
| --- | --- | --- |
| `github.com/modelcontextprotocol/servers` (README list) | curated, **no API** | basis for the `built-in` presets |
| `registry.modelcontextprotocol.io` | canonical **registry with REST API** | the `official-registry` source |

The result is a hybrid: a built-in offline seed **plus** the live registry — without a
third-party API key (unlike Smithery/mcp.so, which were intentionally not included).

---

## 6. File references

- Hook point: `webview/src/components/mcp/McpSettingsSection.tsx`
- Dialogs: `McpMarketplaceDialog.tsx`, `McpImportDialog.tsx`
- Java marketplace: `src/main/java/com/github/claudecodegui/mcp/marketplace/*`
- Java importer: `src/main/java/com/github/claudecodegui/mcp/importer/*`
- Handlers: `src/main/java/com/github/claudecodegui/handler/{marketplace,importer}/*`
- Handler registration: `src/main/java/com/github/claudecodegui/ui/ChatWindowDelegate.java`
- Types: `webview/src/types/mcp.ts`
- i18n: `webview/src/i18n/locales/*.json` (`mcp.market.*`, `mcp.import.*`)
- Tests: `McpRegistryEntryMapperTest`, `McpServerImportServiceTest`, `McpMarketplaceHttpClientTest`
