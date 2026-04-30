# cotx-sdk-core

Data adapter, state model, and TypeScript types for the cotx-engine
workbench. Consume this from any JavaScript/TypeScript runtime (React or
otherwise) to talk to a running `cotx serve` HTTP daemon.

## Install

```bash
npm install cotx-sdk-core
```

## Quick start

```ts
import {
  createHttpCotxAdapter,
  createDefaultWorkbenchState,
  COTX_LAYER_CATALOG,
} from 'cotx-sdk-core';

const adapter = createHttpCotxAdapter({
  baseUrl: 'http://localhost:3000', // cotx daemon HTTP endpoint
});

const project = await adapter.listProjects();
const perspective = await adapter.getPerspective(project[0].id, 'overall-architecture');

const initial = createDefaultWorkbenchState();
// drive workbench UI off `initial` + incremental updates
```

## What's exported

**Types** (`types/` folder — all TypeScript interfaces):

- `types/explorer.ts` — `ExplorerPerspective`, `ExplorerNode`, `ExplorerEdge`, `NodeStats`, `PerspectiveStats`, layer IDs
- `types/intents.ts` — workbench user intents (`WriteIntent`, `RefactorIntent`, `CompareIntent` …)
- `types/layers.ts` — layer catalog, `isCotxLayerId`, `labelForLayer`, `layerForPerspectiveId`
- `types/adapter.ts` — `CotxDataAdapter`, `ProjectMeta`, `ProjectSummary`, `SearchResults`, `ImpactData`, `DiffData`
- `types/state.ts` — `WorkbenchState`, `CompareState`, `SavedViewRef`

**Runtime**:

- `createHttpCotxAdapter(options)` — the only built-in adapter; calls the
  cotx daemon over HTTP / Streamable HTTP MCP. Options: `{ baseUrl, token?, fetch? }`.
- `normalizePerspective / normalizeNode / normalizeEdge / normalizeNodeStats`
  — shape helpers that accept the raw JSON the daemon ships and emit the
  strict `Explorer*` shapes.
- `createDefaultWorkbenchState`, `serializeWorkbenchState`,
  `deserializeWorkbenchState`, `toUrlState`, `fromUrlState` — state
  codecs for persistence + URL sharing.

## Custom adapters

Implement the `CotxDataAdapter` interface yourself to plug in a different
transport (e.g. a bundled `stdio` worker). Only the methods you call need
to be implemented — unsupported ones can throw.

## License

BSL 1.1 — see the root repository for details.
