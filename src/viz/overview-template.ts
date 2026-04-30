// src/viz/overview-template.ts
import { CotxStore } from '../store/store.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import type { PerspectiveData } from '../store/schema.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function riskBadge(score: number): string {
  let color = '#16c79a';
  let label = 'LOW';
  if (score > 50) { color = '#e94560'; label = 'HIGH'; }
  else if (score > 20) { color = '#f5a623'; label = 'MED'; }
  return `<span class="risk-badge" style="background:${color}22;color:${color};border:1px solid ${color}">${label} ${score}</span>`;
}

function explorerHref(projectName: string, perspectiveId: string, elementId?: string): string {
  const base = `/map/${encodeURIComponent(projectName)}/${encodeURIComponent(perspectiveId)}`;
  if (!elementId) return base;
  return `${base}/${elementId.split('/').map(encodeURIComponent).join('/')}`;
}

export function generateOverviewHtml(projectRoot: string): string {
  const store = new CotxStore(projectRoot);
  const meta = store.readMeta();
  const projectName = meta.project;

  const archStore = new ArchitectureStore(projectRoot);
  const hasArch = archStore.exists();

  let perspectiveCards = '';
  let componentGrid = '';
  let analysisSummary = '';
  let dataFlowSummary = '';
  let topRisks = '';
  let topDependencies = '';
  let topFlows = '';
  let whyComponents = '';

  if (hasArch) {
    const archMeta = archStore.readMeta();

    // Perspective cards
    const cards: string[] = [];
    for (const perspId of archMeta.perspectives) {
      let persp: PerspectiveData;
      try { persp = archStore.readPerspective(perspId); } catch { continue; }
      const desc = archStore.readDescription(perspId) ?? '';
      cards.push(`<a href="/map/${esc(projectName)}/${esc(perspId)}" class="persp-card">
        <div class="persp-title">${esc(persp.label)}</div>
        <div class="persp-desc">${esc(desc.slice(0, 120))}</div>
        <div class="persp-stats">${persp.components.length} components, ${persp.edges.length} edges</div>
      </a>`);
      if (perspId === 'overall-architecture') analysisSummary = desc;
      if (perspId === 'data-flow') dataFlowSummary = desc;
    }
    perspectiveCards = cards.join('\n');

    // Component risk grid (from overall-architecture)
    try {
      const overall = archStore.readPerspective('overall-architecture');
      const rows = overall.components
        .sort((a, b) => b.stats.risk_score - a.stats.risk_score)
        .map((c) => `<tr>
          <td class="comp-name">${esc(c.label)}</td>
          <td>${riskBadge(c.stats.risk_score)}</td>
          <td>${c.stats.file_count}</td>
          <td>${c.stats.max_cyclomatic}</td>
          <td>${c.stats.function_count}</td>
        </tr>`)
        .join('\n');
      componentGrid = `<table class="risk-grid">
        <thead><tr><th>Component</th><th>Risk</th><th>Files</th><th>Max CC</th><th>Functions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

      topRisks = overall.components
        .slice()
        .sort((a, b) => b.stats.risk_score - a.stats.risk_score)
        .slice(0, 3)
        .map((c) => `<li><a class="insight-link" href="${explorerHref(projectName, 'overall-architecture', c.id)}"><strong>${esc(c.label)}</strong> ${riskBadge(c.stats.risk_score)} <span class="list-copy">${c.stats.file_count} files, max CC ${c.stats.max_cyclomatic}</span></a></li>`)
        .join('');

      topDependencies = overall.edges
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3)
        .map((e) => `<li><a class="insight-link" href="${explorerHref(projectName, 'overall-architecture', e.from)}"><strong>${esc(e.from)}</strong> → <strong>${esc(e.to)}</strong> <span class="list-copy">${esc(e.label || 'dependency')} · ${e.weight}</span></a></li>`)
        .join('');

      whyComponents = overall.components
        .slice(0, 4)
        .map((c) => `<li><a class="insight-link" href="${explorerHref(projectName, 'overall-architecture', c.id)}"><strong>${esc(c.label)}</strong> <span class="list-copy">included because it owns code under ${esc(c.directory)} and participates in the architecture graph.</span></a></li>`)
        .join('');
    } catch { /* no overall-architecture perspective */ }

    try {
      const dataFlow = archStore.readPerspective('data-flow');
      topFlows = dataFlow.edges
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3)
        .map((e) => `<li><a class="insight-link" href="${explorerHref(projectName, 'data-flow', e.from)}"><strong>${esc(e.from)}</strong> → <strong>${esc(e.to)}</strong> <span class="list-copy">${esc(e.label || 'flow')} · ${e.weight}</span></a></li>`)
        .join('');
    } catch { /* no data-flow perspective */ }
  }

  // Stats summary
  const s = meta.stats;
  const statsLine = `${s.modules} modules | ${s.concepts} concepts | ${s.contracts} contracts | ${s.flows} flows`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cotx overview \u2014 ${esc(projectName)}</title>
<style>
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e0e0e0; --text2: #8b949e; --accent: #58a6ff; }
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--bg); color:var(--text); font-family:Inter,system-ui,sans-serif; padding:24px; max-width:1200px; margin:0 auto; }
h1 { font-size:22px; color:var(--accent); margin-bottom:4px; }
.subtitle { font-size:12px; color:var(--text2); margin-bottom:24px; }
h2 { font-size:16px; margin:24px 0 12px; color:var(--text); }
.persp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
.persp-card { display:block; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:14px 18px; text-decoration:none; color:inherit; transition:border-color .15s; }
.persp-card:hover { border-color:var(--accent); }
.persp-title { font-size:15px; font-weight:600; color:var(--accent); margin-bottom:4px; }
.persp-desc { font-size:12px; color:var(--text2); margin-bottom:6px; }
.persp-stats { font-size:11px; color:var(--text2); }
.analysis-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin:18px 0; }
.analysis-card p { color:var(--text2); font-size:13px; line-height:1.6; margin:8px 0; }
.analysis-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:12px; }
.analysis-meta .meta-block { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; }
.analysis-meta .meta-title { font-size:11px; color:var(--accent); margin-bottom:6px; text-transform:uppercase; letter-spacing:0.06em; }
.analysis-meta .meta-copy { font-size:12px; color:var(--text2); line-height:1.5; }
.insight-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin-top:16px; }
.insight-card { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px; }
.insight-card h3 { font-size:12px; color:var(--accent); margin-bottom:8px; text-transform:uppercase; letter-spacing:0.06em; }
.insight-card ul { list-style:none; display:flex; flex-direction:column; gap:8px; }
.insight-card li { font-size:12px; color:var(--text); line-height:1.5; }
.insight-link { display:block; color:inherit; text-decoration:none; background:transparent; border:1px solid transparent; border-radius:8px; padding:8px; margin:-8px; transition:border-color .15s ease, background-color .15s ease; }
.insight-link:hover { border-color:var(--accent); background:#58a6ff12; }
.list-copy { color:var(--text2); font-size:11px; }
.risk-grid { width:100%; border-collapse:collapse; font-size:13px; }
.risk-grid th { text-align:left; padding:8px 12px; border-bottom:1px solid var(--border); color:var(--text2); font-size:11px; font-weight:500; }
.risk-grid td { padding:8px 12px; border-bottom:1px solid var(--border); }
.comp-name { font-weight:500; }
.risk-badge { font-size:11px; padding:2px 8px; border-radius:4px; font-weight:600; }
.stats-line { font-size:13px; color:var(--text2); margin:16px 0; }
</style>
</head>
<body>
<h1>${esc(projectName)}</h1>
<div class="subtitle">compiled ${esc(meta.compiled_at)}</div>
<div class="stats-line">${statsLine}</div>

<div class="analysis-card">
  <h2>Architecture Analysis</h2>
  <p>${esc(analysisSummary || 'Automatic architecture analysis groups source-root-normalized code into components and summarizes cross-component calls.')}</p>
  ${dataFlowSummary ? `<p>${esc(dataFlowSummary)}</p>` : ''}
  <div class="analysis-meta">
    <div class="meta-block">
      <div class="meta-title">How It Was Generated</div>
      <div class="meta-copy">Automatic directory grouping inside detected source roots, cross-component CALLS aggregation, and ELK layered graph rendering.</div>
    </div>
    <div class="meta-block">
      <div class="meta-title">Confidence & Limits</div>
      <div class="meta-copy">This view is auto-generated. It reflects parsed source files and inferred calls, but may compress ambiguous boundaries or miss dynamic runtime behavior.</div>
    </div>
  </div>
  <div class="insight-grid">
    <div class="insight-card">
      <h3>Top Risks</h3>
      <ul>${topRisks || '<li>No high-risk components detected yet.</li>'}</ul>
    </div>
    <div class="insight-card">
      <h3>Top Dependencies</h3>
      <ul>${topDependencies || '<li>No cross-component dependencies detected yet.</li>'}</ul>
    </div>
    <div class="insight-card">
      <h3>Top Flows</h3>
      <ul>${topFlows || '<li>No flow transitions detected yet.</li>'}</ul>
    </div>
    <div class="insight-card">
      <h3>Why These Components</h3>
      <ul>${whyComponents || '<li>Components are chosen from detected source roots and grouped by directory ownership.</li>'}</ul>
    </div>
  </div>
</div>

<h2>Perspectives</h2>
<div class="persp-grid">
${perspectiveCards || '<div style="color:var(--text2)">No architecture data. Run <code>cotx compile</code>.</div>'}
</div>

<h2>Component Risk</h2>
${componentGrid || '<div style="color:var(--text2)">No components.</div>'}
</body>
</html>`;
}
