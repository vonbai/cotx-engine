export function getExplorerClientJs(): string {
  return String.raw`
var payloadEl = document.getElementById('explorer-data');
var payload = payloadEl ? JSON.parse(payloadEl.textContent || '{}') : {};
var PROJECT_NAME = payload.projectName || 'project';
var PERSPECTIVE_ID = payload.perspectiveId || 'overall-architecture';
var PERSPECTIVE = payload.perspective || { components: [], edges: [] };
var ELEMENTS = payload.elements || {};
var FOCUS = payload.focus || null;
var canvas = document.getElementById('graph-canvas');
var graphArea = document.getElementById('graph-area');
var searchInput = document.getElementById('nav-search');
var selectedId = null;
var tx = 0, ty = 0, scale = 1;
var dragging = false, dragStartX = 0, dragStartY = 0, dragTx = 0, dragTy = 0;

var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
var graphNodes = Array.prototype.slice.call(document.querySelectorAll('#graph-canvas .node'));
var graphEdges = Array.prototype.slice.call(document.querySelectorAll('#graph-canvas .edge'));
var renderedGraphIds = {};
graphNodes.forEach(function(node) {
  if (node.dataset.id) renderedGraphIds[node.dataset.id] = true;
});

var aliasBuckets = {};
Object.keys(ELEMENTS).forEach(function(path) {
  var bare = bareId(path);
  if (!aliasBuckets[bare]) aliasBuckets[bare] = [];
  aliasBuckets[bare].push(path);
});

function bareId(path) {
  return String(path || '').split('/').filter(Boolean).slice(-1)[0] || String(path || '');
}

function resolveElementPath(rawId, fallbackParent) {
  if (!rawId) return null;
  if (ELEMENTS[rawId]) return rawId;
  if (fallbackParent) {
    var combined = fallbackParent + '/' + rawId;
    if (ELEMENTS[combined]) return combined;
  }
  var bucket = aliasBuckets[rawId];
  if (bucket && bucket.length === 1) return bucket[0];
  if (bucket && selectedId) {
    var scoped = bucket.find(function(candidate) {
      return selectedId.indexOf(candidate.split('/').slice(0, -1).join('/')) === 0;
    });
    if (scoped) return scoped;
  }
  return bucket && bucket[0] ? bucket[0] : null;
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}

function explorerHref(elementPath) {
  var parts = [
    '',
    'map',
    encodeURIComponent(PROJECT_NAME),
    encodeURIComponent(PERSPECTIVE_ID),
  ];
  if (elementPath) parts.push(String(elementPath).split('/').map(encodeURIComponent).join('/'));
  return parts.join('/');
}

function applyTransform() {
  canvas.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
}

function filterNav() {
  var query = (searchInput && searchInput.value || '').trim().toLowerCase();
  navItems.forEach(function(btn) {
    var haystack = [
      btn.dataset.id,
      btn.dataset.label,
      btn.dataset.path,
      btn.textContent,
    ].join(' ').toLowerCase();
    btn.classList.toggle('hidden', query.length > 0 && haystack.indexOf(query) === -1);
  });
}

function relatedPathsFor(path) {
  var bare = bareId(path);
  var related = {};
  PERSPECTIVE.edges.forEach(function(edge) {
    if (edge.from === bare) {
      var target = resolveElementPath(edge.to);
      if (target) related[target] = true;
    }
    if (edge.to === bare) {
      var source = resolveElementPath(edge.from);
      if (source) related[source] = true;
    }
  });
  return related;
}

function graphFocusPath(path) {
  if (!path) return null;
  var directBare = bareId(path);
  if (renderedGraphIds[directBare]) return directBare;
  var topLevel = String(path).split('/').filter(Boolean)[0];
  if (topLevel && renderedGraphIds[topLevel]) return topLevel;
  return directBare;
}

function applySelectionState(path) {
  selectedId = path || null;
  var graphFocus = selectedId ? graphFocusPath(selectedId) : null;
  var selectedBare = graphFocus ? bareId(graphFocus) : null;
  var related = graphFocus ? relatedPathsFor(graphFocus) : {};
  var relatedBares = {};
  Object.keys(related).forEach(function(key) {
    relatedBares[bareId(key)] = true;
  });

  navItems.forEach(function(btn) {
    var isSelected = !!selectedId && btn.dataset.id === selectedId;
    var isRelated = !!selectedId && !!related[btn.dataset.id];
    btn.classList.toggle('active', isSelected);
    btn.classList.toggle('related', isRelated);
  });

  graphNodes.forEach(function(node) {
    var nodeId = node.dataset.id || '';
    var isSelected = !!selectedBare && nodeId === selectedBare;
    var isRelated = !!selectedBare && !isSelected && !!relatedBares[nodeId];
    var shouldDim = !!selectedBare && !isSelected && !isRelated;
    node.classList.toggle('selected', isSelected);
    node.classList.toggle('related', isRelated);
    node.classList.toggle('dimmed', shouldDim);
  });

  graphEdges.forEach(function(edge) {
    var from = edge.dataset.from || '';
    var to = edge.dataset.to || '';
    var isSelected = !!selectedBare && (from === selectedBare || to === selectedBare);
    var isRelated = !!selectedBare && !isSelected && (relatedBares[from] || relatedBares[to]);
    var shouldDim = !!selectedBare && !isSelected && !isRelated;
    edge.classList.toggle('selected', isSelected);
    edge.classList.toggle('related', isRelated);
    edge.classList.toggle('dimmed', shouldDim);
  });
}

function attachRelationshipHandlers() {
  document.querySelectorAll('.relationship-link,.child-link').forEach(function(el) {
    el.addEventListener('click', function() {
      var target = el.getAttribute('data-target');
      if (target) selectComponent(target);
    });
  });
}

function relationshipButton(target, title, meta, className) {
  return '<button type="button" class="' + className + '" data-target="' + escHtml(target) + '">' +
    escHtml(title) +
    (meta ? '<span class="relationship-copy">' + escHtml(meta) + '</span>' : '') +
  '</button>';
}

function renderMiniDiagram(diagramText) {
  if (!diagramText) return '';
  var lines = String(diagramText).split('\n').map(function(line) { return line.trim(); }).filter(Boolean);
  if (lines.length === 0) return '';
  var direction = lines[0].includes('LR') ? 'LR' : 'TD';
  var nodes = [];
  var nodeMap = {};
  var edges = [];

  lines.slice(1).forEach(function(line) {
    var nodeMatch = line.match(/^([A-Za-z0-9_/-]+)\["([^"]+)"\]$/);
    if (nodeMatch) {
      var normalizedLabel = nodeMatch[2].replace(/\\n/g, '\n');
      var node = { id: nodeMatch[1], label: normalizedLabel.split('\n')[0] };
      nodes.push(node);
      nodeMap[node.id] = node;
      return;
    }
    var edgeMatch = line.match(/^([A-Za-z0-9_/-]+)\s*-->(?:\|"([^"]*)"\|)?\s*([A-Za-z0-9_/-]+)$/);
    if (edgeMatch) {
      edges.push({ from: edgeMatch[1], label: edgeMatch[2] || '', to: edgeMatch[3] });
      if (!nodeMap[edgeMatch[1]]) {
        nodeMap[edgeMatch[1]] = { id: edgeMatch[1], label: edgeMatch[1] };
        nodes.push(nodeMap[edgeMatch[1]]);
      }
      if (!nodeMap[edgeMatch[3]]) {
        nodeMap[edgeMatch[3]] = { id: edgeMatch[3], label: edgeMatch[3] };
        nodes.push(nodeMap[edgeMatch[3]]);
      }
    }
  });

  var width = direction === 'LR' ? Math.max(180, nodes.length * 120) : 220;
  var height = direction === 'TD' ? Math.max(100, nodes.length * 56) : 110;
  var coords = {};
  nodes.forEach(function(node, idx) {
    coords[node.id] = direction === 'LR'
      ? { x: 20 + idx * 110, y: 28 }
      : { x: 50, y: 20 + idx * 46 };
  });

  var svg = '<svg class="diagram-preview" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="' + height + '">';
  svg += '<defs><marker id="mini-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#8b949e"/></marker></defs>';
  edges.forEach(function(edge) {
    var from = coords[edge.from];
    var to = coords[edge.to];
    if (!from || !to) return;
    var x1 = from.x + 70;
    var y1 = from.y + 16;
    var x2 = direction === 'LR' ? to.x : to.x + 70;
    var y2 = direction === 'LR' ? to.y + 16 : to.y;
    svg += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#8b949e" stroke-width="1.5" marker-end="url(#mini-arrow)"/>';
    if (edge.label) {
      svg += '<text x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 4) + '" text-anchor="middle" fill="#8b949e" font-size="9">' + escHtml(edge.label) + '</text>';
    }
  });
  nodes.forEach(function(node) {
    var pos = coords[node.id];
    svg += '<rect x="' + pos.x + '" y="' + pos.y + '" width="70" height="24" rx="6" fill="#161b22" stroke="#30363d"/>';
    svg += '<text x="' + (pos.x + 35) + '" y="' + (pos.y + 16) + '" text-anchor="middle" fill="#e0e0e0" font-size="10">' + escHtml(node.label) + '</text>';
  });
  svg += '</svg>';
  return svg;
}

function selectComponent(id) {
  var resolvedId = resolveElementPath(id) || id;
  var comp = ELEMENTS[resolvedId];
  if (!comp) return;
  var focusPath = graphFocusPath(resolvedId) || resolvedId;
  var sidebar = document.getElementById('sidebar');
  sidebar.classList.add('visible');
  document.getElementById('sb-title').textContent = comp.label;

  var html = '';
  html += '<div class="field"><div class="field-label">Path</div><div class="field-value" style="font-family:monospace;font-size:11px">' + escHtml(comp.path) + '</div></div>';
  html += '<div class="field"><div class="field-label">Breadcrumb</div><div class="breadcrumb">' + resolvedId.split('/').map(function(part) {
    return '<span class="breadcrumb-chip">' + escHtml(part) + '</span>';
  }).join('') + '</div></div>';
  if (focusPath !== resolvedId) {
    html += '<div class="field"><div class="field-label">Graph Context</div><div class="field-value"><button type="button" class="relationship-link" data-target="' + escHtml(focusPath) + '">' + escHtml(ELEMENTS[focusPath] ? ELEMENTS[focusPath].label : focusPath) + '<span class="relationship-copy">' + escHtml(focusPath) + '</span></button></div></div>';
  }
  html += '<div class="field"><div class="field-label">Directory</div><div class="field-value" style="font-family:monospace;font-size:11px">' + escHtml(comp.directory) + '</div></div>';
  html += '<div class="field"><div class="field-label">Kind</div><div class="field-value">' + escHtml(comp.kind) + '</div></div>';
  if (comp.description) {
    html += '<div class="field"><div class="field-label">Description</div><div class="field-value">' + escHtml(comp.description) + '</div></div>';
  }
  if (comp.diagram) {
    html += '<div class="field"><div class="field-label">Diagram</div><div class="field-value">' + renderMiniDiagram(comp.diagram) + '</div></div>';
  }
  html += '<div id="sb-stats">';
  html += '<div class="stat-row"><span>Files</span><span>' + comp.stats.file_count + '</span></div>';
  html += '<div class="stat-row"><span>Functions</span><span>' + comp.stats.function_count + '</span></div>';
  html += '<div class="stat-row"><span>Max CC</span><span>' + comp.stats.max_cyclomatic + '</span></div>';
  html += '<div class="stat-row"><span>Max Nesting</span><span>' + comp.stats.max_nesting_depth + '</span></div>';
  html += '<div class="stat-row"><span>Risk Score</span><span>' + comp.stats.risk_score + '</span></div>';
  html += '</div>';

  if (comp.files && comp.files.length > 0) {
    html += '<div class="field"><div class="field-label">Files</div><ul class="file-list">';
    comp.files.forEach(function(f) { html += '<li>' + escHtml(f) + '</li>'; });
    html += '</ul></div>';
  }
  if (comp.exported_functions && comp.exported_functions.length > 0) {
    html += '<div class="field"><div class="field-label">Exports</div><div class="field-value" style="font-family:monospace;font-size:11px">' + escHtml(comp.exported_functions.join(', ')) + '</div></div>';
  }
  if (comp.contracts_provided && comp.contracts_provided.length > 0) {
    html += '<div class="field"><div class="field-label">Contracts Provided</div><div class="field-value" style="font-family:monospace;font-size:11px">' + escHtml(comp.contracts_provided.join(', ')) + '</div></div>';
  }
  if (comp.contracts_consumed && comp.contracts_consumed.length > 0) {
    html += '<div class="field"><div class="field-label">Contracts Consumed</div><div class="field-value" style="font-family:monospace;font-size:11px">' + escHtml(comp.contracts_consumed.join(', ')) + '</div></div>';
  }
  if (comp.related_flows && comp.related_flows.length > 0) {
    html += '<div class="field"><div class="field-label">Related Flows</div><div class="field-value" style="font-family:monospace;font-size:11px">' + escHtml(comp.related_flows.join(', ')) + '</div></div>';
  }

  if (comp.children && comp.children.length > 0) {
    html += '<div class="field"><div class="field-label">Children</div><div class="relationship-stack">';
    comp.children.forEach(function(childId) {
      var childPath = resolveElementPath(childId, resolvedId) || (resolvedId + '/' + childId);
      var childComp = ELEMENTS[childPath];
      html += relationshipButton(
        childPath,
        childComp ? childComp.label : childId,
        childComp ? childComp.directory : childPath,
        'child-link'
      );
    });
    html += '</div></div>';
  }

  var bare = bareId(focusPath);
  var outEdges = PERSPECTIVE.edges.filter(function(e) { return e.from === bare; });
  var inEdges = PERSPECTIVE.edges.filter(function(e) { return e.to === bare; });
  if (outEdges.length > 0) {
    html += '<div class="field"><div class="field-label">Depends on</div><div class="relationship-stack">';
    outEdges.forEach(function(edge) {
      var targetPath = resolveElementPath(edge.to, focusPath) || edge.to;
      var target = ELEMENTS[targetPath];
      html += relationshipButton(
        targetPath,
        (target ? target.label : edge.to),
        (edge.label || 'dependency') + ' · ' + targetPath,
        'relationship-link'
      );
    });
    html += '</div></div>';
  }
  if (inEdges.length > 0) {
    html += '<div class="field"><div class="field-label">Depended by</div><div class="relationship-stack">';
    inEdges.forEach(function(edge) {
      var sourcePath = resolveElementPath(edge.from, focusPath) || edge.from;
      var source = ELEMENTS[sourcePath];
      html += relationshipButton(
        sourcePath,
        (source ? source.label : edge.from),
        (edge.label || 'dependency') + ' · ' + sourcePath,
        'relationship-link'
      );
    });
    html += '</div></div>';
  }

  html += '<div class="field"><div class="field-label">Deep Link</div><div class="field-value"><a href="' + explorerHref(resolvedId) + '" style="color:#58a6ff;text-decoration:none">' + escHtml(explorerHref(resolvedId)) + '</a></div></div>';

  document.getElementById('sb-content').innerHTML = html;
  attachRelationshipHandlers();
  applySelectionState(resolvedId);

  if (window.history && window.history.replaceState) {
    window.history.replaceState({}, '', explorerHref(resolvedId));
  }
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('visible');
  document.getElementById('sb-content').innerHTML = '';
  applySelectionState(null);
  if (window.history && window.history.replaceState) {
    window.history.replaceState({}, '', explorerHref());
  }
}

graphArea.addEventListener('mousedown', function(e) {
  if (e.target.closest && e.target.closest('.node')) return;
  dragging = true;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragTx = tx;
  dragTy = ty;
});

window.addEventListener('mousemove', function(e) {
  if (!dragging) return;
  tx = dragTx + (e.clientX - dragStartX);
  ty = dragTy + (e.clientY - dragStartY);
  applyTransform();
});

window.addEventListener('mouseup', function() {
  dragging = false;
});

graphArea.addEventListener('wheel', function(e) {
  e.preventDefault();
  var delta = e.deltaY > 0 ? 0.9 : 1.1;
  var newScale = Math.min(4, Math.max(0.2, scale * delta));
  var rect = graphArea.getBoundingClientRect();
  var mx = e.clientX - rect.left;
  var my = e.clientY - rect.top;
  tx = mx - (mx - tx) * (newScale / scale);
  ty = my - (my - ty) * (newScale / scale);
  scale = newScale;
  applyTransform();
}, { passive: false });

if (searchInput) {
  searchInput.addEventListener('input', filterNav);
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      searchInput.value = '';
      filterNav();
    }
  });
}

document.querySelectorAll('#graph-canvas .node').forEach(function(g) {
  g.style.cursor = 'pointer';
  g.addEventListener('click', function(e) {
    e.stopPropagation();
    selectComponent(g.dataset.id);
  });
});

if (FOCUS) {
  selectComponent(FOCUS);
} else {
  applySelectionState(null);
}

graphArea.addEventListener('click', function(e) {
  if (e.target === graphArea || e.target === canvas) {
    closeSidebar();
  }
});
`;
}
