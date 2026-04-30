import { ArchitectureStore } from '../store/architecture-store.js';
import { renderElkSvg } from './elk-renderer.js';
import type { ArchitectureElement } from '../store/schema.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function generateExplorerHtml(
  projectRoot: string,
  perspectiveId: string,
  focusElement?: string,
): Promise<string> {
  const archStore = new ArchitectureStore(projectRoot);
  const perspective = archStore.readPerspective(perspectiveId);
  const svg = await renderElkSvg(perspective);
  const projectName = projectRoot.split('/').filter(Boolean).pop() ?? 'project';

  type ExplorerElement = ArchitectureElement & {
    path: string;
    description?: string | null;
    diagram?: string | null;
  };

  const topLevelPaths = [...new Set([
    ...perspective.components.map((c) => c.id),
    ...archStore.listChildren(perspectiveId),
  ])].sort();

  const elementsByPath: Record<string, ExplorerElement> = {};

  const loadElement = (elementPath: string): ExplorerElement | null => {
    if (elementsByPath[elementPath]) return elementsByPath[elementPath];

    let data: ArchitectureElement | undefined;
    try {
      data = archStore.readElement(perspectiveId, elementPath);
    } catch {
      data = perspective.components.find((component) => component.id === elementPath);
    }
    if (!data) return null;

    const fullPath = `${perspectiveId}/${elementPath}`;
    const enriched: ExplorerElement = {
      ...data,
      path: elementPath,
      description: archStore.readDescription(fullPath),
      diagram: archStore.readDiagram(fullPath),
    };
    elementsByPath[elementPath] = enriched;
    return enriched;
  };

  for (const path of topLevelPaths) loadElement(path);
  for (const path of archStore.listElementPaths(perspectiveId)) loadElement(path);

  function riskClass(score: number): string {
    return score > 50 ? 'high' : score > 20 ? 'med' : 'low';
  }

  function renderNav(path: string, depth: number): string {
    const element = loadElement(path);
    if (!element) return '';
    const children = archStore.listChildren(`${perspectiveId}/${path}`);
    const button = `<button class="nav-item ${focusElement === path ? 'active' : ''}" data-id="${esc(path)}" data-label="${esc(element.label)}" data-path="${esc(element.directory || path)}" style="padding-left:${16 + depth * 16}px" onclick='selectComponent(${JSON.stringify(path)})'><span class="nav-copy"><span class="nav-label">${esc(element.label)}</span><span class="nav-path">${esc(element.directory || path)}</span></span><span class="risk-dot ${riskClass(element.stats.risk_score)}"></span></button>`;
    const nested = children.map((child) => renderNav(`${path}/${child}`, depth + 1)).join('\n');
    return `${button}${nested}`;
  }

  const navItems = topLevelPaths.map((path) => renderNav(path, 0)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cotx explorer \u2014 ${esc(perspective.label)}</title>
<style>
:root { --bg:#0d1117; --surface:#161b22; --raised:#1c2128; --border:#30363d; --text:#e0e0e0; --text2:#8b949e; --accent:#58a6ff; }
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); color:var(--text); font-family:Inter,system-ui,sans-serif; height:100vh; overflow:hidden; display:flex; }
#left-nav { width:300px; background:var(--surface); border-right:1px solid var(--border); overflow-y:auto; padding:12px 0; flex-shrink:0; scrollbar-width:none; -ms-overflow-style:none; }
#left-nav::-webkit-scrollbar { display:none; }
#left-nav h3 { font-size:13px; padding:8px 16px 4px; color:var(--accent); }
.nav-toolbar { padding:0 16px 12px; border-bottom:1px solid var(--border); margin-bottom:8px; }
#nav-search { width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:9px 10px; font-size:12px; font-family:inherit; }
#nav-search:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px #58a6ff22; }
.nav-hint { margin-top:6px; font-size:10px; color:var(--text2); line-height:1.4; }
.nav-section { display:flex; flex-direction:column; gap:2px; padding-bottom:12px; }
.nav-item { display:flex; align-items:center; justify-content:space-between; width:100%; padding:8px 16px; border:none; background:none; color:var(--text); font-size:12px; cursor:pointer; text-align:left; font-family:inherit; gap:8px; }
.nav-item:hover { background:var(--raised); }
.nav-item.active { background:var(--accent)22; color:var(--accent); }
.nav-item.related { background:#58a6ff12; }
.nav-item.hidden { display:none; }
.nav-copy { display:flex; flex-direction:column; min-width:0; }
.nav-label { font-size:12px; line-height:1.2; }
.nav-path { font-size:10px; line-height:1.2; color:var(--text2); font-family:monospace; overflow:hidden; text-overflow:ellipsis; }
.risk-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.risk-dot.low { background:#16c79a; }
.risk-dot.med { background:#f5a623; }
.risk-dot.high { background:#e94560; }
#graph-area {
  flex:1;
  overflow:hidden;
  padding:0;
  cursor:grab;
  background-image: radial-gradient(circle, #30363d 1px, transparent 1px);
  background-size: 24px 24px;
  background-position: 0 0;
  position:relative;
}
#graph-area:active { cursor:grabbing; }
#graph-canvas { position:absolute; top:20px; left:20px; transform-origin:0 0; }
#graph-canvas .node,
#graph-canvas .edge { transition:opacity .16s ease, transform .16s ease, filter .16s ease; }
#graph-canvas .node.selected rect { stroke:#58a6ff; stroke-width:3; filter:drop-shadow(0 0 12px rgba(88,166,255,.28)); }
#graph-canvas .node.related rect { stroke:#9cd1ff; stroke-width:2.5; }
#graph-canvas .node.dimmed,
#graph-canvas .edge.dimmed { opacity:.22; }
#graph-canvas .edge.selected polyline { stroke:#58a6ff; stroke-width:2.25; fill:none; }
#graph-canvas .edge.selected text { fill:#9cd1ff; }
#graph-canvas .edge.related polyline { stroke:#9cd1ff; stroke-width:1.9; fill:none; }
#graph-canvas .edge.related text { fill:#9cd1ff; }
#sidebar { width:360px; background:var(--surface); border-left:1px solid var(--border); overflow-y:auto; padding:16px; flex-shrink:0; display:none; }
#sidebar.visible { display:block; }
#sidebar-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
#sidebar h3 { font-size:14px; color:var(--accent); }
#sidebar-close { background:none; border:none; color:var(--text2); cursor:pointer; font-size:18px; padding:0 4px; font-family:inherit; }
#sidebar-close:hover { color:var(--text); }
#sidebar .field { margin-bottom:12px; }
#sidebar .field-label { font-size:10px; color:var(--text2); text-transform:uppercase; margin-bottom:2px; letter-spacing:0.05em; }
#sidebar .field-value { font-size:12px; line-height:1.5; }
#sidebar .file-list { list-style:none; font-size:11px; color:var(--text2); margin-top:4px; }
#sidebar .file-list li { padding:2px 0; font-family:monospace; }
#sidebar .stat-row { display:flex; justify-content:space-between; font-size:12px; padding:5px 0; border-bottom:1px solid var(--border); }
#sidebar .stat-row:last-child { border-bottom:none; }
#sb-stats { background:var(--raised); border-radius:6px; padding:8px 12px; margin-bottom:12px; }
.diagram-preview { display:block; width:100%; height:auto; background:#0d1117; border:1px solid var(--border); border-radius:6px; padding:6px; }
.relationship-stack { display:flex; flex-direction:column; gap:6px; }
.relationship-link,
.child-link { width:100%; text-align:left; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:8px 10px; font-size:11px; line-height:1.4; font-family:inherit; cursor:pointer; }
.relationship-link:hover,
.child-link:hover { border-color:var(--accent); background:#58a6ff14; }
.relationship-copy { color:var(--text2); font-size:10px; display:block; margin-top:2px; font-family:monospace; }
.breadcrumb { display:flex; flex-wrap:wrap; gap:6px; }
.breadcrumb-chip { background:var(--bg); color:var(--text2); border:1px solid var(--border); border-radius:999px; padding:3px 8px; font-size:10px; }
</style>
</head>
<body>
<nav id="left-nav">
<h3>${esc(perspective.label)}</h3>
<div class="nav-toolbar">
  <input id="nav-search" type="search" placeholder="Filter components or paths" autocomplete="off" />
  <div class="nav-hint">Search by label, directory, or nested path to cut through repeated names.</div>
</div>
<div id="nav-items" class="nav-section">
${navItems}
</div>
</nav>
<div id="graph-area">
  <div id="graph-canvas">
${svg}
  </div>
</div>
<div id="sidebar">
  <div id="sidebar-header">
    <h3 id="sb-title"></h3>
    <button id="sidebar-close" onclick="closeSidebar()" title="Close">\u00d7</button>
  </div>
  <div id="sb-content"></div>
</div>
<script type="application/json" id="explorer-data">${JSON.stringify({
    projectName,
    perspectiveId,
    perspective,
    elements: elementsByPath,
    focus: focusElement ?? null,
  }).replace(/</g, '\\u003c')}</script>
<script src="/assets/explorer.js"></script>
</body>
</html>`;
}
