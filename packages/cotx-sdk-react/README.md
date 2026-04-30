# cotx-sdk-react

React components and hooks for building a cotx workbench UI. Thin
wrapper over [`cotx-sdk-core`](../cotx-sdk-core); renders the
architecture explorer (tree + canvas + inspector) and wires up state.

## Install

```bash
npm install cotx-sdk-react cotx-sdk-core
```

Peer dependencies (you bring): `react ^18 || ^19`, `react-dom` matching.

## Quick start

```tsx
import { CotxProvider, ArchitectureCanvas } from 'cotx-sdk-react';
import 'cotx-sdk-react/theme.css';
import { createHttpCotxAdapter } from 'cotx-sdk-core';

const adapter = createHttpCotxAdapter({ baseUrl: 'http://localhost:3000' });

export function App() {
  return (
    <CotxProvider adapter={adapter} projectId="my-project">
      <ArchitectureCanvas perspectiveId="overall-architecture" />
    </CotxProvider>
  );
}
```

## Components

- **`<CotxProvider adapter projectId>`** — root context; every component
  below reads the adapter + state through it.
- **`<ArchitectureCanvas>`** — AntV G6 Leaflet-style pan/zoom map of an
  architecture perspective (nodes, edges, ELK-laid-out).
- **`<ArchitectureTree>`** — collapsible hierarchy of perspectives and
  their components; clicking selects the focused node.
- **`<ArchitectureInspector>`** — right-side panel showing the current
  selection's description, diagram, data, and enrichment status.
- **`<LayerOverview>`** — summary card of all layers with counts.
- **`<FilterBar>`** — search + layer filter for the tree/canvas.
- **`<SavedViewsPanel>`** — persistable named views of the explorer state.

## Hooks

- **`useCotxWorkbench()`** — returns the workbench state + action creators.
  Use this in custom components to drive the explorer programmatically.

## Theme

Ships a default theme at `cotx-sdk-react/theme.css`. Import it once at
your app root.

## G6 spec adapter

If you want to render the graph yourself, `toG6Spec(perspective)` returns
the raw `G6GraphSpec` the built-in canvas uses.

## License

BSL 1.1.
