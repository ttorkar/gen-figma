(function () {
  'use strict';

  const STORAGE_KEY = 'gen-figma-board';
  const DEFAULT_VIEW = { panX: 80, panY: 80, zoom: 1 };
  const STATUS_COLORS = { red: '#dc2626', yellow: '#ca8a04', green: '#16a34a', black: '#18181b' };

  let state = {
    nodes: [],
    edges: [],
    view: { ...DEFAULT_VIEW },
    selection: [],
    undoStack: [],
    redoStack: [],
  };

  const $ = (id) => document.getElementById(id);
  const canvasWrap = $('canvas-wrap');
  const canvas = $('canvas');
  const edgesLayer = $('edges-layer');
  const nodesLayer = $('nodes-layer');
  const propertiesPanel = $('properties-panel');
  const propertiesContent = $('properties-content');

  function uid() {
    return 'id_' + Math.random().toString(36).slice(2, 11);
  }


  function applyView() {
    const { panX, panY, zoom } = state.view;
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }


  function getNode(id) {
    return state.nodes.find((n) => n.id === id);
  }


  function getNodeCenter(node) {
    return {
      x: node.x + (node.width || 120) / 2,
      y: node.y + (node.height || 40) / 2,
    };
  }


  function pushUndo() {
    state.redoStack = [];
    state.undoStack.push(JSON.stringify({ nodes: state.nodes, edges: state.edges, view: state.view }));
    if (state.undoStack.length > 50) state.undoStack.shift();
  }


  function undo() {
    if (state.undoStack.length === 0) return;
    state.redoStack.push(JSON.stringify({ nodes: state.nodes, edges: state.edges, view: state.view }));
    const prev = JSON.parse(state.undoStack.pop());
    state.nodes = prev.nodes;
    state.edges = prev.edges;
    state.view = prev.view;
    state.selection = [];
    render();
    persist();
  }


  function redo() {
    if (state.redoStack.length === 0) return;
    state.undoStack.push(JSON.stringify({ nodes: state.nodes, edges: state.edges, view: state.view }));
    const next = JSON.parse(state.redoStack.pop());
    state.nodes = next.nodes;
    state.edges = next.edges;
    state.view = next.view;
    state.selection = [];
    render();
    persist();
  }


  function addNode(type, x = 100, y = 100) {
    pushUndo();
    const node =
      type === 'text'
        ? { id: uid(), type: 'text', x, y, width: 200, height: 80, text: 'New text' }
        : {
            id: uid(),
            type: 'status',
            x,
            y,
            width: 140,
            height: 44,
            color: 'yellow',
            label: 'RFR',
          };
    state.nodes.push(node);
    state.selection = [node.id];
    render();
    persist();
    openProperties();
  }


  function deleteSelected() {
    const ids = state.selection.slice();
    if (ids.length === 0) return;
    pushUndo();
    state.nodes = state.nodes.filter((n) => !ids.includes(n.id));
    state.edges = state.edges.filter((e) => !ids.includes(e.fromId) && !ids.includes(e.toId));
    state.selection = [];
    render();
    persist();
    closeProperties();
  }


  function connectSelected() {
    if (state.selection.length !== 2) return;
    const [fromId, toId] = state.selection;
    if (state.edges.some((e) => e.fromId === fromId && e.toId === toId)) return;
    pushUndo();
    state.edges.push({ id: uid(), fromId, toId });
    render();
    persist();
  }


  function updateNode(id, patch) {
    const node = getNode(id);
    if (!node) return;
    pushUndo();
    Object.assign(node, patch);
    render();
    persist();
    if (state.selection.length === 1 && state.selection[0] === id) renderProperties();
  }


  function renderNodes() {
    nodesLayer.innerHTML = '';
    state.nodes.forEach((node) => {
      const el = document.createElement('div');
      el.className = 'node node-' + node.type + (state.selection.includes(node.id) ? ' selected' : '');
      el.dataset.id = node.id;
      el.style.left = node.x + 'px';
      el.style.top = node.y + 'px';
      el.style.width = (node.width || 120) + 'px';
      el.style.minHeight = (node.height || 40) + 'px';

      if (node.type === 'text') {
        const inner = document.createElement('div');
        inner.className = 'node-text';
        inner.textContent = node.text || '';
        inner.contentEditable = 'true';
        inner.spellcheck = false;
        inner.addEventListener('input', () => updateNode(node.id, { text: inner.textContent }));
        inner.addEventListener('mousedown', (e) => e.stopPropagation());
        el.appendChild(inner);
      } else {
        const inner = document.createElement('div');
        inner.className = 'node-status';
        inner.style.background = STATUS_COLORS[node.color] || STATUS_COLORS.yellow;
        inner.textContent = node.label || 'Status';
        el.appendChild(inner);
      }

      el.addEventListener('mousedown', (e) => onNodeMouseDown(e, node));
      nodesLayer.appendChild(el);
    });
  }


  function renderEdges() {
    const d = state.view.zoom;
    let svg = '';
    state.edges.forEach((edge) => {
      const from = getNode(edge.fromId);
      const to = getNode(edge.toId);
      if (!from || !to) return;
      const A = getNodeCenter(from);
      const B = getNodeCenter(to);
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const head = 12;
      const tipX = B.x - ux * head;
      const tipY = B.y - uy * head;
      const ax = tipX - uy * 6;
      const ay = tipY + ux * 6;
      const bx = tipX + uy * 6;
      const by = tipY - ux * 6;
      svg += `<path d="M ${A.x} ${A.y} L ${tipX} ${tipY} L ${ax} ${ay} M ${tipX} ${tipY} L ${bx} ${by}" fill="none" stroke="#ea580c" stroke-width="${2/d}" stroke-linecap="round"/>`;
    });
    edgesLayer.innerHTML = svg;
  }


  function render() {
    renderNodes();
    renderEdges();
    applyView();
    $('btn-undo').disabled = state.undoStack.length === 0;
    $('btn-redo').disabled = state.redoStack.length === 0;
  }


  function renderProperties() {
    if (state.selection.length !== 1) {
      propertiesContent.innerHTML = '<p class="muted">Select one node to edit.</p>';
      return;
    }
    const node = getNode(state.selection[0]);
    if (!node) return;
    if (node.type === 'text') {
      propertiesContent.innerHTML = `
        <div class="prop-row">
          <label>Text</label>
          <textarea id="prop-text" rows="4">${escapeHtml(node.text || '')}</textarea>
        </div>
        <div class="prop-row">
          <label>Width</label>
          <input type="number" id="prop-width" value="${node.width || 200}" min="60" />
        </div>
        <div class="prop-row">
          <label>Height</label>
          <input type="number" id="prop-height" value="${node.height || 80}" min="24" />
        </div>
      `;
      propertiesContent.querySelector('#prop-text').addEventListener('input', (e) => updateNode(node.id, { text: e.target.value }));
      propertiesContent.querySelector('#prop-width').addEventListener('change', (e) => updateNode(node.id, { width: Number(e.target.value) || 120 }));
      propertiesContent.querySelector('#prop-height').addEventListener('change', (e) => updateNode(node.id, { height: Number(e.target.value) || 40 }));
    } else {
      propertiesContent.innerHTML = `
        <div class="prop-row">
          <label>Label</label>
          <input type="text" id="prop-label" value="${escapeHtml(node.label || '')}" placeholder="e.g. WFM, RFR, App" />
        </div>
        <div class="prop-row">
          <label>Color</label>
          <select id="prop-color">
            ${Object.entries(STATUS_COLORS).map(([k, v]) => `<option value="${k}" ${node.color === k ? 'selected' : ''}>${k}</option>`).join('')}
          </select>
        </div>
        <div class="prop-row">
          <label>Width</label>
          <input type="number" id="prop-width" value="${node.width || 140}" min="60" />
        </div>
        <div class="prop-row">
          <label>Height</label>
          <input type="number" id="prop-height" value="${node.height || 44}" min="24" />
        </div>
      `;
      propertiesContent.querySelector('#prop-label').addEventListener('input', (e) => updateNode(node.id, { label: e.target.value }));
      propertiesContent.querySelector('#prop-color').addEventListener('change', (e) => updateNode(node.id, { color: e.target.value }));
      propertiesContent.querySelector('#prop-width').addEventListener('change', (e) => updateNode(node.id, { width: Number(e.target.value) || 120 }));
      propertiesContent.querySelector('#prop-height').addEventListener('change', (e) => updateNode(node.id, { height: Number(e.target.value) || 40 }));
    }
  }


  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }


  function openProperties() {
    propertiesPanel.classList.remove('hidden');
    renderProperties();
  }


  function closeProperties() {
    propertiesPanel.classList.add('hidden');
  }


  function selectOnly(id) {
    state.selection = id ? [id] : [];
    render();
    if (state.selection.length === 1) {
      openProperties();
      renderProperties();
    } else closeProperties();
  }


  function onNodeMouseDown(e, node) {
    e.preventDefault();
    e.stopPropagation();
    if (!state.selection.includes(node.id)) selectOnly(node.id);

    let startX = e.clientX;
    let startY = e.clientY;
    let startNodeX = node.x;
    let startNodeY = node.y;
    let undoPushed = false;

    const onMove = (e2) => {
      const dx = (e2.clientX - startX) / state.view.zoom;
      const dy = (e2.clientY - startY) / state.view.zoom;
      if (!undoPushed && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        pushUndo();
        undoPushed = true;
      }
      startX = e2.clientX;
      startY = e2.clientY;
      startNodeX += dx;
      startNodeY += dy;
      node.x = Math.round(startNodeX / 10) * 10;
      node.y = Math.round(startNodeY / 10) * 10;
      render();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persist();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }


  function initPanZoom() {
    let panStart = { x: 0, y: 0 };
    let viewStart = { panX: 0, panY: 0 };

    canvas.addEventListener('mousedown', (e) => {
      if (e.target.closest('.node')) return;
      canvas.classList.add('panning');
      panStart = { x: e.clientX, y: e.clientY };
      viewStart = { ...state.view };
    });
    document.addEventListener('mousemove', (e) => {
      if (!canvas.classList.contains('panning')) return;
      state.view.panX = viewStart.panX + (e.clientX - panStart.x);
      state.view.panY = viewStart.panY + (e.clientY - panStart.y);
      applyView();
    });
    document.addEventListener('mouseup', () => {
      canvas.classList.remove('panning');
    });

    canvasWrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvasWrap.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const worldX = (mx - state.view.panX) / state.view.zoom;
      const worldY = (my - state.view.panY) / state.view.zoom;
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newZoom = Math.max(0.25, Math.min(2, state.view.zoom + delta));
      state.view.zoom = newZoom;
      state.view.panX = mx - worldX * newZoom;
      state.view.panY = my - worldY * newZoom;
      applyView();
      renderEdges();
    }, { passive: false });
  }


  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: state.nodes, edges: state.edges, view: state.view }));
    } catch (_) {}
  }


  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        state.nodes = data.nodes || [];
        state.edges = data.edges || [];
        state.view = data.view || { ...DEFAULT_VIEW };
      }
    } catch (_) {}
  }


  function exportJson() {
    const blob = new Blob(
      [JSON.stringify({ nodes: state.nodes, edges: state.edges, view: state.view }, null, 2)],
      { type: 'application/json' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'board.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }


  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        pushUndo();
        state.nodes = data.nodes || [];
        state.edges = data.edges || [];
        if (data.view) state.view = data.view;
        state.selection = [];
        render();
        persist();
      } catch (e) {
        alert('Invalid JSON: ' + e.message);
      }
    };
    reader.readAsText(file);
  }


  function initToolbar() {
    $('btn-add-text').addEventListener('click', () => addNode('text'));
    $('btn-add-status').addEventListener('click', () => addNode('status'));
    $('btn-connect').addEventListener('click', connectSelected);
    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-export-json').addEventListener('click', exportJson);
    $('btn-import-json').addEventListener('click', () => $('input-import-json').click());
    $('input-import-json').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) importJson(f);
      e.target.value = '';
    });
    $('btn-close-props').addEventListener('click', closeProperties);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target;
        if (target.closest('.node-text') && target.isContentEditable) return;
        e.preventDefault();
        deleteSelected();
      }
      if (e.key === 'Escape') selectOnly(null);
    });
  }


  load();
  initPanZoom();
  initToolbar();
  render();
})();
