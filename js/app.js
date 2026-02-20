(function () {
  'use strict';

  const DEFAULT_VIEW = { panX: 80, panY: 80, zoom: 1 };
  const STATUS_COLORS = { red: '#dc2626', yellow: '#ca8a04', green: '#16a34a', black: '#18181b' };

  let useFileBackend = false;
  let persistToFileTimer = null;
  let collabWs = null;
  let collabReconnectTimer = null;
  let collabStatus = 'disconnected';
  let presenceUsers = [];
  let myUserId = null;
  let spaceHeld = false;
  let marqueeStart = null;
  let marqueeEl = null;

  let state = {
    nodes: [],
    edges: [],
    view: { ...DEFAULT_VIEW },
    selection: [],
    selectedEdgeId: null,
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

  const messages = [];
  let messageIdNext = 0;


  function showMessage(text, type = 'error') {
    const id = ++messageIdNext;
    messages.push({ id, text, type });
    renderMessages();
    return id;
  }


  function dismissMessage(id) {
    const i = messages.findIndex((m) => m.id === id);
    if (i !== -1) {
      messages.splice(i, 1);
      renderMessages();
    }
  }


  function renderMessages() {
    const el = $('message-list');
    if (!el) return;
    el.innerHTML = messages
      .map(
        (m) =>
          `<div class="message message--${m.type}" data-id="${m.id}">
            <span class="message__text">${escapeHtml(m.text)}</span>
            <button type="button" class="message__dismiss" aria-label="Dismiss" data-id="${m.id}">×</button>
          </div>`
      )
      .join('');
    el.querySelectorAll('.message__dismiss').forEach((btn) => {
      btn.addEventListener('click', () => dismissMessage(Number(btn.dataset.id)));
    });
  }

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


  function getCheckboxItems(node) {
    if (node.items && node.items.length > 0) return node.items;
    return [{ id: node.id + '_0', text: node.text || 'Task', checked: !!node.checked }];
  }


  function getNodeCenter(node) {
    return {
      x: node.x + (node.width || 120) / 2,
      y: node.y + (node.height || 40) / 2,
    };
  }


  function getNodeRect(node) {
    const w = node.width || 120;
    const h = node.height || 40;
    return { x: node.x, y: node.y, w, h };
  }


  function segmentRectIntersections(ax, ay, bx, by, rx, ry, rw, rh) {
    const out = [];
    const left = rx;
    const right = rx + rw;
    const top = ry;
    const bottom = ry + rh;
    const dx = bx - ax;
    const dy = by - ay;
    const tMin = 0;
    const tMax = 1;
    if (dx !== 0) {
      let t = (left - ax) / dx;
      if (t >= tMin && t <= tMax) {
        const y = ay + t * dy;
        if (y >= top && y <= bottom) out.push({ x: left, y });
      }
      t = (right - ax) / dx;
      if (t >= tMin && t <= tMax) {
        const y = ay + t * dy;
        if (y >= top && y <= bottom) out.push({ x: right, y });
      }
    }
    if (dy !== 0) {
      let t = (top - ay) / dy;
      if (t >= tMin && t <= tMax) {
        const x = ax + t * dx;
        if (x >= left && x <= right) out.push({ x, y: top });
      }
      t = (bottom - ay) / dy;
      if (t >= tMin && t <= tMax) {
        const x = ax + t * dx;
        if (x >= left && x <= right) out.push({ x, y: bottom });
      }
    }
    return out;
  }


  function edgeEndpoints(from, to) {
    const A = getNodeCenter(from);
    const B = getNodeCenter(to);
    const rFrom = getNodeRect(from);
    const rTo = getNodeRect(to);
    const fromPts = segmentRectIntersections(A.x, A.y, B.x, B.y, rFrom.x, rFrom.y, rFrom.w, rFrom.h);
    const toPts = segmentRectIntersections(A.x, A.y, B.x, B.y, rTo.x, rTo.y, rTo.w, rTo.h);
    let start = A;
    let end = B;
    if (fromPts.length > 0) {
      const distSq = (p) => (p.x - A.x) ** 2 + (p.y - A.y) ** 2;
      fromPts.sort((p, q) => distSq(q) - distSq(p));
      start = fromPts[0];
    }
    if (toPts.length > 0) {
      const distSq = (p) => (p.x - A.x) ** 2 + (p.y - A.y) ** 2;
      toPts.sort((p, q) => distSq(p) - distSq(q));
      end = toPts[0];
    }
    return { start, end };
  }


  function statusColor(node) {
    const c = node.color;
    if (typeof c === 'string' && /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(c)) return c;
    return STATUS_COLORS[c] || '#ca8a04';
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
    let node;
    if (type === 'text') {
      node = { id: uid(), type: 'text', x, y, width: 200, height: 80, text: 'New text', fontSize: 14 };
    } else if (type === 'checkbox') {
      node = { id: uid(), type: 'checkbox', x, y, width: 200, height: 32, items: [{ id: uid(), text: 'Task', checked: false }] };
    } else {
      node = {
        id: uid(),
        type: 'status',
        x,
        y,
        width: 140,
        height: 44,
        color: '#ca8a04',
        text: 'RFR',
      };
    }
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
    if (state.selection.length < 2) return;
    const fromId = state.selection[state.selection.length - 2];
    const toId = state.selection[state.selection.length - 1];
    if (state.edges.some((e) => e.fromId === fromId && e.toId === toId)) return;
    pushUndo();
    state.edges.push({ id: uid(), fromId, toId, color: '#ea580c', label: '', dashed: false, bidirectional: false });
    render();
    persist();
  }


  function disconnectSelected() {
    if (state.selection.length !== 2) return;
    const edge = getEdgeBetween(state.selection[0], state.selection[1]);
    if (!edge) return;
    pushUndo();
    state.edges = state.edges.filter((e) => e.id !== edge.id);
    render();
    persist();
    renderProperties();
  }


  function duplicateSelected() {
    if (state.selection.length === 0) return;
    pushUndo();
    const offset = 24;
    const newIds = [];
    state.selection.forEach((id) => {
      const node = getNode(id);
      if (!node) return;
      const copy = JSON.parse(JSON.stringify(node));
      copy.id = uid();
      if (copy.items && copy.items.length) copy.items = copy.items.map((i) => ({ ...i, id: uid() }));
      copy.x = (copy.x || 0) + offset;
      copy.y = (copy.y || 0) + offset;
      state.nodes.push(copy);
      newIds.push(copy.id);
    });
    state.selection = newIds;
    render();
    persist();
    if (newIds.length === 1) {
      openProperties();
      renderProperties();
    }
  }


  function zoomToFit() {
    if (state.nodes.length === 0) return;
    const padding = 60;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.nodes.forEach((n) => {
      const w = n.width || 120;
      const h = n.height || 40;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w);
      maxY = Math.max(maxY, n.y + h);
    });
    const boxW = maxX - minX + padding * 2;
    const boxH = maxY - minY + padding * 2;
    const rect = canvasWrap.getBoundingClientRect();
    const scale = Math.min(rect.width / boxW, rect.height / boxH, 1.5);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    state.view.zoom = scale;
    state.view.panX = rect.width / 2 - cx * scale;
    state.view.panY = rect.height / 2 - cy * scale;
    applyView();
    renderEdges();
  }


  function updateNode(id, patch) {
    const node = getNode(id);
    if (!node) return;
    if (node.type === 'checkbox' && !node.items) node.items = getCheckboxItems(node);
    if (node.type === 'checkbox' && node.items && node.items.length > 0) {
      if ('text' in patch) node.items[0].text = patch.text;
      if ('checked' in patch) node.items[0].checked = patch.checked;
    }
    const textOnly = Object.keys(patch).length === 1 && ('text' in patch || ('checked' in patch && node.type === 'checkbox'));
    if (!textOnly) pushUndo();
    Object.assign(node, patch);
    if (!textOnly) render();
    persist();
    if (state.selection.length === 1 && state.selection[0] === id) {
      if (textOnly) {
        const active = document.activeElement;
        const ta = propertiesContent.querySelector('#prop-text');
        if (ta && ta !== active) ta.value = node.text || '';
        const cbText = propertiesContent.querySelector('#prop-checkbox-text');
        if (cbText && cbText !== active) cbText.value = node.text || '';
        const statusText = propertiesContent.querySelector('#prop-status-text');
        if (statusText && statusText !== active) statusText.value = node.text != null ? node.text : (node.label || '');
        const nodeEl = nodesLayer.querySelector('[data-id="' + id + '"]');
        if (nodeEl) {
          const textEl = nodeEl.querySelector('.node-text');
          if (textEl && !textEl.contains(active)) textEl.textContent = node.text || '';
          const labelEl = nodeEl.querySelector('.node-checkbox-label');
          if (labelEl && getCheckboxItems(node).length === 1 && !labelEl.contains(active)) labelEl.textContent = (node.items && node.items[0] ? node.items[0].text : node.text) || '';
          const statusEl = nodeEl.querySelector('.node-status');
          if (statusEl && statusEl !== active) statusEl.textContent = node.text != null ? node.text : (node.label || 'Status');
        }
      } else renderProperties();
    }
  }


  function updateCheckboxItem(nodeId, itemId, patch) {
    const node = getNode(nodeId);
    if (!node || node.type !== 'checkbox') return;
    const items = getCheckboxItems(node).map((i) => (i.id === itemId ? { ...i, ...patch } : i));
    node.items = items;
    node.height = Math.max(node.height || 32, items.length * 32 + 12);
    const textOnly = Object.keys(patch).length === 1 && 'text' in patch;
    const checkedOnly = Object.keys(patch).length === 1 && 'checked' in patch;
    if (!textOnly) pushUndo();
    if (textOnly || checkedOnly) {
      const nodeEl = nodesLayer.querySelector('[data-id="' + nodeId + '"]');
      if (nodeEl) {
        const row = nodeEl.querySelector('[data-item-id="' + itemId + '"]');
        if (row) {
          if ('text' in patch) {
            const label = row.querySelector('.node-checkbox-label');
            if (label && label !== document.activeElement) label.textContent = patch.text || '';
          }
          if ('checked' in patch) {
            const input = row.querySelector('input[type="checkbox"]');
            if (input) input.checked = !!patch.checked;
          }
        }
      }
      persist();
      if (state.selection.length === 1 && state.selection[0] === nodeId) renderProperties();
    } else {
      render();
      persist();
      if (state.selection.length === 1 && state.selection[0] === nodeId) renderProperties();
    }
  }


  function addCheckboxItem(nodeId) {
    const node = getNode(nodeId);
    if (!node || node.type !== 'checkbox') return;
    const items = getCheckboxItems(node).concat([{ id: uid(), text: 'Task', checked: false }]);
    node.items = items;
    node.height = Math.max(node.height || 32, items.length * 32 + 12);
    pushUndo();
    render();
    persist();
    if (state.selection.length === 1 && state.selection[0] === nodeId) renderProperties();
  }


  function removeCheckboxItem(nodeId, itemId) {
    const node = getNode(nodeId);
    if (!node || node.type !== 'checkbox') return;
    let items = getCheckboxItems(node).filter((i) => i.id !== itemId);
    if (items.length === 0) items = [{ id: uid(), text: 'Task', checked: false }];
    node.items = items;
    node.height = Math.max(32, items.length * 32 + 12);
    pushUndo();
    render();
    persist();
    if (state.selection.length === 1 && state.selection[0] === nodeId) renderProperties();
  }


  function updateEdge(edgeId, patch) {
    const edge = state.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    pushUndo();
    Object.assign(edge, patch);
    render();
    persist();
    if (state.selection.length === 2 || state.selectedEdgeId === edgeId) renderProperties();
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
        inner.style.fontSize = (node.fontSize != null ? node.fontSize : 14) + 'px';
        inner.textContent = node.text || '';
        inner.contentEditable = 'true';
        inner.spellcheck = false;
        inner.addEventListener('focus', () => pushUndo());
        inner.addEventListener('input', (e) => {
          const el = e.target;
          requestAnimationFrame(() => updateNode(node.id, { text: el.innerText }));
        });
        inner.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          if (!state.selection.includes(node.id)) selectOnly(node.id);
        });
        el.appendChild(inner);
        ['e', 's', 'se'].forEach((edge) => {
          const handle = document.createElement('div');
          handle.className = 'node-resize-handle node-resize-' + edge;
          handle.dataset.resize = edge;
          handle.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); onResizeStart(e, node, edge); });
          el.appendChild(handle);
        });
      } else if (node.type === 'checkbox') {
        const inner = document.createElement('div');
        inner.className = 'node-checkbox node-checkbox--multi';
        const dragHandle = document.createElement('div');
        dragHandle.className = 'node-checkbox-drag';
        dragHandle.title = 'Drag to move';
        dragHandle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!state.selection.includes(node.id)) selectOnly(node.id);
          startNodeDrag(e, node);
        });
        inner.appendChild(dragHandle);
        const list = document.createElement('div');
        list.className = 'node-checkbox-list';
        const items = getCheckboxItems(node);
        if (!node.items) node.items = items;
        items.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'node-checkbox-row';
          row.dataset.itemId = item.id;
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = !!item.checked;
          input.dataset.itemId = item.id;
          input.addEventListener('change', () => updateCheckboxItem(node.id, item.id, { checked: input.checked }));
          const label = document.createElement('span');
          label.className = 'node-checkbox-label';
          label.textContent = item.text || 'Task';
          label.contentEditable = 'true';
          label.spellcheck = false;
          label.dataset.itemId = item.id;
          label.addEventListener('input', () => updateCheckboxItem(node.id, item.id, { text: label.innerText }));
          label.addEventListener('focus', () => pushUndo());
          row.appendChild(input);
          row.appendChild(label);
          list.appendChild(row);
        });
        inner.appendChild(list);
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'node-checkbox-add';
        addBtn.title = 'Add item';
        addBtn.textContent = '+';
        addBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); addCheckboxItem(node.id); });
        inner.appendChild(addBtn);
        el.appendChild(inner);
        ['e', 's', 'se'].forEach((resizeEdge) => {
          const handle = document.createElement('div');
          handle.className = 'node-resize-handle node-resize-' + resizeEdge;
          handle.dataset.resize = resizeEdge;
          handle.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); onResizeStart(ev, node, resizeEdge); });
          el.appendChild(handle);
        });
      } else {
        const inner = document.createElement('div');
        inner.className = 'node-status';
        inner.style.background = statusColor(node);
        inner.textContent = node.text != null ? node.text : (node.label || 'Status');
        el.appendChild(inner);
        ['e', 's', 'se'].forEach((resizeEdge) => {
          const handle = document.createElement('div');
          handle.className = 'node-resize-handle node-resize-' + resizeEdge;
          handle.dataset.resize = resizeEdge;
          handle.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); onResizeStart(ev, node, resizeEdge); });
          el.appendChild(handle);
        });
      }

      if (state.selection.includes(node.id)) {
        const actions = document.createElement('div');
        actions.className = 'node-actions';
        const btnDup = document.createElement('button');
        btnDup.type = 'button';
        btnDup.className = 'node-action-btn';
        btnDup.title = 'Duplicate';
        btnDup.textContent = '⎘';
        btnDup.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); duplicateSelected(); });
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'node-action-btn node-action-delete';
        btnDel.title = 'Delete';
        btnDel.textContent = '×';
        btnDel.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); deleteSelected(); });
        actions.appendChild(btnDup);
        actions.appendChild(btnDel);
        el.appendChild(actions);
      }

      el.addEventListener('mousedown', (e) => onNodeMouseDown(e, node));
      nodesLayer.appendChild(el);
    });
  }


  function getEdgeBetween(aId, bId) {
    return state.edges.find((e) => (e.fromId === aId && e.toId === bId) || (e.fromId === bId && e.toId === aId));
  }


  function renderEdges() {
    const d = state.view.zoom;
    const strokeW = 2 / d;
    const hitStroke = 24;
    let svg = '';
    state.edges.forEach((edge) => {
      const from = getNode(edge.fromId);
      const to = getNode(edge.toId);
      if (!from || !to) return;
      const { start, end } = edgeEndpoints(from, to);
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const headLen = 14;
      const headWid = 8;
      const tipX = end.x;
      const tipY = end.y;
      const lineEndX = end.x - ux * headLen;
      const lineEndY = end.y - uy * headLen;
      const ax = lineEndX - uy * headWid;
      const ay = lineEndY + ux * headWid;
      const bx = lineEndX + uy * headWid;
      const by = lineEndY - ux * headWid;
      const stroke = edge.color || '#ea580c';
      const dash = edge.dashed ? ` stroke-dasharray="${8/d} ${6/d}"` : '';
      const selected = state.selectedEdgeId === edge.id;
      const lineW = selected ? strokeW * 1.8 : strokeW;
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      svg += `<g data-edge-id="${edge.id}" style="pointer-events:auto;cursor:pointer">`;
      svg += `<path d="M ${start.x} ${start.y} L ${end.x} ${end.y}" fill="none" stroke="transparent" stroke-width="${hitStroke}" stroke-linecap="round" pointer-events="stroke"/>`;
      svg += `<path d="M ${start.x} ${start.y} L ${lineEndX} ${lineEndY}" fill="none" stroke="${stroke}" stroke-width="${lineW}" stroke-linecap="round"${dash}/>`;
      svg += `<polygon points="${tipX},${tipY} ${ax},${ay} ${bx},${by}" fill="${stroke}"/>`;
      if (edge.bidirectional) {
        const lineStartX = start.x + ux * headLen;
        const lineStartY = start.y + uy * headLen;
        const cx = start.x + uy * headWid;
        const cy = start.y - ux * headWid;
        const ex = start.x - uy * headWid;
        const ey = start.y + ux * headWid;
        svg += `<path d="M ${lineEndX} ${lineEndY} L ${lineStartX} ${lineStartY}" fill="none" stroke="${stroke}" stroke-width="${lineW}" stroke-linecap="round"${dash}/>`;
        svg += `<polygon points="${start.x},${start.y} ${cx},${cy} ${ex},${ey}" fill="${stroke}"/>`;
      }
      if (edge.label) {
        const fs = Math.max(10, 12 / d);
        svg += `<text x="${midX}" y="${midY}" text-anchor="middle" dominant-baseline="middle" fill="${stroke}" font-size="${fs}" font-family="system-ui,sans-serif" pointer-events="none">${escapeHtml(edge.label)}</text>`;
      }
      svg += `</g>`;
    });
    edgesLayer.innerHTML = svg;
  }


  function selectEdge(edgeId) {
    state.selectedEdgeId = edgeId;
    state.selection = [];
    render();
    openProperties();
    renderProperties();
  }


  function render() {
    renderNodes();
    renderEdges();
    applyView();
    $('btn-undo').disabled = state.undoStack.length === 0;
    $('btn-redo').disabled = state.redoStack.length === 0;
  }


  function renderProperties() {
    if (state.selectedEdgeId) {
      const edge = state.edges.find((e) => e.id === state.selectedEdgeId);
      if (!edge) {
        state.selectedEdgeId = null;
        propertiesContent.innerHTML = '<p class="muted">Select a node or an arrow to edit.</p>';
        return;
      }
      const edgeColor = edge.color || '#ea580c';
      propertiesContent.innerHTML = `
        <div class="prop-row">
          <label>Arrow / connection</label>
        </div>
        <div class="prop-row">
          <label>Color</label>
          <input type="color" id="edge-color" value="${edgeColor}" style="height: 32px; padding: 2px; cursor: pointer;" />
        </div>
        <div class="prop-row">
          <label>Label (on line)</label>
          <input type="text" id="edge-label" value="${escapeHtml(edge.label || '')}" placeholder="e.g. merge" />
        </div>
        <div class="prop-row">
          <label><input type="checkbox" id="edge-dashed" ${edge.dashed ? 'checked' : ''} /> Dashed line</label>
        </div>
        <div class="prop-row">
          <label><input type="checkbox" id="edge-bidirectional" ${edge.bidirectional ? 'checked' : ''} /> Two-way arrow</label>
        </div>
        <div class="prop-row">
          <button type="button" id="edge-delete-btn">Delete connection</button>
        </div>
      `;
      propertiesContent.querySelector('#edge-color').addEventListener('input', (e) => updateEdge(edge.id, { color: e.target.value }));
      propertiesContent.querySelector('#edge-label').addEventListener('input', (e) => updateEdge(edge.id, { label: e.target.value }));
      propertiesContent.querySelector('#edge-dashed').addEventListener('change', (e) => updateEdge(edge.id, { dashed: e.target.checked }));
      propertiesContent.querySelector('#edge-bidirectional').addEventListener('change', (e) => updateEdge(edge.id, { bidirectional: e.target.checked }));
      propertiesContent.querySelector('#edge-delete-btn').addEventListener('click', () => {
        pushUndo();
        state.edges = state.edges.filter((e) => e.id !== edge.id);
        state.selectedEdgeId = null;
        render();
        persist();
        renderProperties();
      });
      return;
    }
    if (state.selection.length === 0) {
      propertiesContent.innerHTML = '<p class="muted">Select one node to edit, or click an arrow to edit it.</p>';
      return;
    }
    if (state.selection.length === 2) {
      const a = getNode(state.selection[0]);
      const b = getNode(state.selection[1]);
      const edge = a && b ? getEdgeBetween(state.selection[0], state.selection[1]) : null;
      if (!edge) {
        propertiesContent.innerHTML = '<p class="muted">No connection between these nodes. Click Connect to add an arrow.</p>';
        return;
      }
      const edgeColor = edge.color || '#ea580c';
      propertiesContent.innerHTML = `
        <div class="prop-row">
          <label>Arrow / connection</label>
        </div>
        <div class="prop-row">
          <label>Color</label>
          <input type="color" id="edge-color" value="${edgeColor}" style="height: 32px; padding: 2px; cursor: pointer;" />
        </div>
        <div class="prop-row">
          <label>Label (on line)</label>
          <input type="text" id="edge-label" value="${escapeHtml(edge.label || '')}" placeholder="e.g. merge" />
        </div>
        <div class="prop-row">
          <label><input type="checkbox" id="edge-dashed" ${edge.dashed ? 'checked' : ''} /> Dashed line</label>
        </div>
        <div class="prop-row">
          <label><input type="checkbox" id="edge-bidirectional" ${edge.bidirectional ? 'checked' : ''} /> Two-way arrow</label>
        </div>
        <div class="prop-row">
          <button type="button" id="edge-delete-btn">Delete connection</button>
        </div>
      `;
      propertiesContent.querySelector('#edge-color').addEventListener('input', (e) => updateEdge(edge.id, { color: e.target.value }));
      propertiesContent.querySelector('#edge-label').addEventListener('input', (e) => updateEdge(edge.id, { label: e.target.value }));
      propertiesContent.querySelector('#edge-dashed').addEventListener('change', (e) => updateEdge(edge.id, { dashed: e.target.checked }));
      propertiesContent.querySelector('#edge-bidirectional').addEventListener('change', (e) => updateEdge(edge.id, { bidirectional: e.target.checked }));
      propertiesContent.querySelector('#edge-delete-btn').addEventListener('click', () => {
        pushUndo();
        state.edges = state.edges.filter((e) => e.id !== edge.id);
        state.selectedEdgeId = null;
        render();
        persist();
        renderProperties();
      });
      return;
    }
    const node = getNode(state.selection[0]);
    if (!node) return;
    if (node.type === 'text') {
      propertiesContent.innerHTML = `
        <div class="prop-row">
          <label>Text</label>
          <textarea id="prop-text" rows="${Math.max(2, (node.text || '').split('\n').length + 1)}">${escapeHtml(node.text || '')}</textarea>
        </div>
        <div class="prop-row">
          <label>Font size</label>
          <select id="prop-fontSize">
            ${(function () {
              const sizes = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96];
              const current = node.fontSize != null ? node.fontSize : 14;
              if (!sizes.includes(current)) sizes.unshift(current);
              return sizes.map((n) => `<option value="${n}" ${current === n ? 'selected' : ''}>${n}px</option>`).join('');
            })()}
          </select>
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
      propertiesContent.querySelector('#prop-fontSize').addEventListener('change', (e) => updateNode(node.id, { fontSize: Number(e.target.value) || 14 }));
      propertiesContent.querySelector('#prop-width').addEventListener('change', (e) => updateNode(node.id, { width: Number(e.target.value) || 120 }));
      propertiesContent.querySelector('#prop-height').addEventListener('change', (e) => updateNode(node.id, { height: Number(e.target.value) || 40 }));
    } else if (node.type === 'checkbox') {
      const items = getCheckboxItems(node);
      const itemsHtml = items
        .map(
          (item, idx) => `
        <div class="prop-checkbox-item" data-item-id="${escapeHtml(item.id)}">
          <label class="prop-checkbox-item-row">
            <input type="checkbox" class="prop-checkbox-item-checked" ${item.checked ? 'checked' : ''} />
            <input type="text" class="prop-checkbox-item-text" value="${escapeHtml(item.text || '')}" placeholder="Task" />
            <button type="button" class="prop-checkbox-item-remove" title="Remove" aria-label="Remove">×</button>
          </label>
        </div>`
        )
        .join('');
      propertiesContent.innerHTML = `
        <div class="prop-row">
          <label>Items</label>
          <div class="prop-checkbox-items">${itemsHtml}</div>
          <button type="button" id="prop-checkbox-add">Add item</button>
        </div>
        <div class="prop-row">
          <label>Width</label>
          <input type="number" id="prop-width" value="${node.width || 200}" min="80" />
        </div>
      `;
      propertiesContent.querySelectorAll('.prop-checkbox-item-checked').forEach((input) => {
        const itemId = input.closest('.prop-checkbox-item').dataset.itemId;
        input.addEventListener('change', (e) => updateCheckboxItem(node.id, itemId, { checked: e.target.checked }));
      });
      propertiesContent.querySelectorAll('.prop-checkbox-item-text').forEach((input) => {
        const itemId = input.closest('.prop-checkbox-item').dataset.itemId;
        input.addEventListener('input', (e) => updateCheckboxItem(node.id, itemId, { text: e.target.value }));
      });
      propertiesContent.querySelectorAll('.prop-checkbox-item-remove').forEach((btn) => {
        const itemId = btn.closest('.prop-checkbox-item').dataset.itemId;
        btn.addEventListener('click', () => removeCheckboxItem(node.id, itemId));
      });
      propertiesContent.querySelector('#prop-checkbox-add').addEventListener('click', () => addCheckboxItem(node.id));
      propertiesContent.querySelector('#prop-width').addEventListener('change', (e) => updateNode(node.id, { width: Number(e.target.value) || 200 }));
    } else {
      const colorVal = statusColor(node);
      propertiesContent.innerHTML = `
        <div class="prop-row">
          <label>Text</label>
          <textarea id="prop-status-text" rows="${Math.max(2, ((node.text != null ? node.text : node.label) || '').split('\n').length + 1)}" placeholder="e.g. WFM, RFR, App">${escapeHtml((node.text != null ? node.text : node.label) || '')}</textarea>
        </div>
        <div class="prop-row">
          <label>Color</label>
          <input type="color" id="prop-color" value="${colorVal}" style="height: 32px; padding: 2px; cursor: pointer;" />
          <input type="text" id="prop-color-hex" value="${colorVal}" placeholder="#ca8a04" style="margin-top: 4px; width: 100%;" />
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
      propertiesContent.querySelector('#prop-status-text').addEventListener('input', (e) => updateNode(node.id, { text: e.target.value }));
      const statusTa = propertiesContent.querySelector('#prop-status-text');
      if (statusTa) statusTa.spellcheck = false;
      const setColor = (hex) => {
        hex = hex.replace(/^\s*#?/, '#');
        if (/^#[0-9a-fA-F]{6}$/.test(hex) || /^#[0-9a-fA-F]{3}$/.test(hex)) updateNode(node.id, { color: hex });
      };
      propertiesContent.querySelector('#prop-color').addEventListener('input', (e) => {
        setColor(e.target.value);
        propertiesContent.querySelector('#prop-color-hex').value = e.target.value;
      });
      propertiesContent.querySelector('#prop-color-hex').addEventListener('change', (e) => {
        setColor(e.target.value);
        const c = statusColor(getNode(node.id));
        propertiesContent.querySelector('#prop-color').value = c;
      });
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
    state.selectedEdgeId = null;
    state.selection = id ? [id] : [];
    render();
    if (state.selection.length === 1) {
      openProperties();
      renderProperties();
    } else closeProperties();
  }


  function screenToCanvas(clientX, clientY) {
    const rect = canvasWrap.getBoundingClientRect();
    return {
      x: (clientX - rect.left - state.view.panX) / state.view.zoom,
      y: (clientY - rect.top - state.view.panY) / state.view.zoom,
    };
  }


  function onResizeStart(e, node, edge) {
    const resizable = node.type === 'text' || node.type === 'status' || node.type === 'checkbox';
    if (!resizable) return;
    pushUndo();
    const minW = node.type === 'checkbox' ? 80 : 60;
    const minH = node.type === 'checkbox' ? 32 : 24;

    const onMove = (e2) => {
      const p = screenToCanvas(e2.clientX, e2.clientY);
      if (edge.includes('e')) {
        const w = Math.max(minW, p.x - node.x);
        node.width = Math.round(w / 10) * 10;
      }
      if (edge.includes('s')) {
        const h = Math.max(minH, p.y - node.y);
        node.height = Math.round(h / 10) * 10;
      }
      render();
      if (state.selection.length === 1 && state.selection[0] === node.id) renderProperties();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persist();
      if (state.selection.length === 1 && state.selection[0] === node.id) renderProperties();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }


  function startNodeDrag(e, node) {
    const moveIds = state.selection.length > 1 && state.selection.includes(node.id)
      ? state.selection.slice()
      : [node.id];
    const startPositions = moveIds.map((id) => {
      const n = getNode(id);
      return n ? { id, x: n.x, y: n.y } : null;
    }).filter(Boolean);
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
      const totalDx = startNodeX - (startPositions.find((p) => p.id === node.id).x);
      const totalDy = startNodeY - (startPositions.find((p) => p.id === node.id).y);
      startPositions.forEach((p) => {
        const n = getNode(p.id);
        if (n) {
          n.x = Math.round((p.x + totalDx) / 10) * 10;
          n.y = Math.round((p.y + totalDy) / 10) * 10;
        }
      });
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


  function onNodeMouseDown(e, node) {
    e.preventDefault();
    e.stopPropagation();
    if (node.type === 'checkbox' && (e.target.type === 'checkbox' || e.target.closest('.node-checkbox-label'))) {
      if (!state.selection.includes(node.id)) selectOnly(node.id);
      return;
    }
    if (e.shiftKey) {
      const idx = state.selection.indexOf(node.id);
      if (idx === -1) state.selection.push(node.id);
      else state.selection.splice(idx, 1);
      render();
      if (state.selection.length === 1) {
        openProperties();
        renderProperties();
      } else if (state.selection.length === 0) closeProperties();
      else renderProperties();
      return;
    }
    if (!state.selection.includes(node.id)) selectOnly(node.id);
    startNodeDrag(e, node);
  }


  function initPanZoom() {
    let panStart = { x: 0, y: 0 };
    let viewStart = { panX: 0, panY: 0 };

    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        const active = document.activeElement;
        if (!active || (active.tagName !== 'INPUT' && active.tagName !== 'TEXTAREA' && !active.isContentEditable)) {
          e.preventDefault();
          spaceHeld = true;
          document.body.classList.add('space-held');
        }
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        spaceHeld = false;
        document.body.classList.remove('space-held');
      }
    });

    canvas.addEventListener('mousedown', (e) => {
      if (e.target.closest('.node')) return;
      if (e.target.closest('[data-edge-id]')) return;
      state.selectedEdgeId = null;
      if (spaceHeld) {
        canvas.classList.add('panning');
        panStart = { x: e.clientX, y: e.clientY };
        viewStart = { ...state.view };
      } else {
        marqueeStart = { x: e.clientX, y: e.clientY };
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (marqueeStart) {
        const dx = e.clientX - marqueeStart.x;
        const dy = e.clientY - marqueeStart.y;
        if (!marqueeEl && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
          marqueeEl = document.createElement('div');
          marqueeEl.className = 'marquee-rect';
          marqueeEl.setAttribute('aria-hidden', 'true');
          canvasWrap.appendChild(marqueeEl);
        }
        if (marqueeEl) {
          const left = Math.min(marqueeStart.x, e.clientX);
          const top = Math.min(marqueeStart.y, e.clientY);
          const w = Math.abs(dx);
          const h = Math.abs(dy);
          const rect = canvasWrap.getBoundingClientRect();
          marqueeEl.style.left = (left - rect.left) + 'px';
          marqueeEl.style.top = (top - rect.top) + 'px';
          marqueeEl.style.width = w + 'px';
          marqueeEl.style.height = h + 'px';
        }
        return;
      }
      if (canvas.classList.contains('panning')) {
        state.view.panX = viewStart.panX + (e.clientX - panStart.x);
        state.view.panY = viewStart.panY + (e.clientY - panStart.y);
        applyView();
      }
    });
    document.addEventListener('mouseup', () => {
      if (marqueeEl) {
        const ml = parseFloat(marqueeEl.style.left);
        const mt = parseFloat(marqueeEl.style.top);
        const mw = parseFloat(marqueeEl.style.width);
        const mh = parseFloat(marqueeEl.style.height);
        const r = {
          x: (ml - state.view.panX) / state.view.zoom,
          y: (mt - state.view.panY) / state.view.zoom,
          w: mw / state.view.zoom,
          h: mh / state.view.zoom,
        };
        const hit = state.nodes.filter((n) => {
          const nr = getNodeRect(n);
          return !(nr.x + nr.w < r.x || nr.x > r.x + r.w || nr.y + nr.h < r.y || nr.y > r.y + r.h);
        });
        state.selection = hit.map((n) => n.id);
        marqueeEl.remove();
        marqueeEl = null;
        marqueeStart = null;
        render();
        if (state.selection.length === 1) { openProperties(); renderProperties(); }
        else if (state.selection.length === 0) closeProperties();
        else renderProperties();
      } else if (marqueeStart) {
        selectOnly(null);
        marqueeStart = null;
      }
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
    if (!useFileBackend) return;
    const payload = JSON.stringify({ nodes: state.nodes, edges: state.edges, view: state.view }, null, 2);
    if (persistToFileTimer) clearTimeout(persistToFileTimer);
    persistToFileTimer = setTimeout(() => {
      fetch('/board.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
        .then((r) => { if (!r.ok) throw new Error('Save failed'); })
        .catch(() => { showMessage('Failed to save to board.json. Is the server running?', 'error'); });
    }, 400);
  }


  function applyBoardFromServer(data) {
    if (persistToFileTimer) return;
    state.nodes = data.nodes || [];
    state.edges = data.edges || [];
    state.nodes.forEach((n) => {
      if (n.type === 'checkbox' && !n.items) n.items = getCheckboxItems(n);
    });
    render();
  }


  function setCollabStatus(status) {
    collabStatus = status;
    const el = $('collab-status');
    if (!el) return;
    el.textContent = status === 'connected' ? 'Connected' : status === 'reconnecting' ? 'Reconnecting…' : status === 'offline' ? 'Offline' : '';
    el.className = 'collab-status ' + (status === 'connected' ? 'connected' : status === 'reconnecting' ? 'reconnecting' : status === 'offline' ? 'offline' : '');
    el.style.display = status ? 'block' : 'none';
  }

  function renderPresence() {
    const el = $('presence-list');
    if (!el) return;
    if (presenceUsers.length === 0) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const name = (typeof localStorage !== 'undefined' && localStorage.getItem('gen-figma-name')) || 'Anonymous';
    el.innerHTML = '<div class="presence-list__title">Online</div>' +
      presenceUsers.map((u) => '<div class="presence-list__user' + (u.id === myUserId ? ' presence-list__user--you' : '') + '">' + escapeHtml(u.name) + (u.id === myUserId ? ' (you)' : '') + '</div>').join('') +
      '<button type="button" class="presence-list__set-name" id="presence-set-name">Set your name</button>';
    el.querySelector('#presence-set-name').addEventListener('click', () => {
      const v = prompt('Your name', name);
      if (v != null && v.trim()) {
        try { localStorage.setItem('gen-figma-name', v.trim().slice(0, 32)); } catch (_) {}
        if (collabWs && collabWs.readyState === 1) collabWs.send(JSON.stringify({ type: 'hello', name: v.trim().slice(0, 32) }));
        renderPresence();
      }
    });
  }

  function connectCollab() {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = scheme + '//' + location.host;
    const ws = new WebSocket(url);
    setCollabStatus('reconnecting');

    ws.onopen = () => {
      setCollabStatus('connected');
      const name = (typeof localStorage !== 'undefined' && localStorage.getItem('gen-figma-name')) || 'Anonymous';
      ws.send(JSON.stringify({ type: 'hello', name }));
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data && data.type === 'init') {
          myUserId = data.yourId;
          presenceUsers = data.users || [];
          applyBoardFromServer(data.board);
          renderPresence();
          return;
        }
        if (data && data.type === 'presence') {
          presenceUsers = data.users || [];
          renderPresence();
          return;
        }
        applyBoardFromServer(data);
      } catch (_) {}
    };

    ws.onclose = () => {
      collabWs = null;
      setCollabStatus('offline');
      presenceUsers = [];
      renderPresence();
      if (collabReconnectTimer) clearTimeout(collabReconnectTimer);
      collabReconnectTimer = setTimeout(() => {
        setCollabStatus('reconnecting');
        connectCollab();
      }, 3000);
    };
    ws.onerror = () => {};
    collabWs = ws;
  }


  function loadFromFile(cb) {
    fetch('/board.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText || 'Failed to load'))))
      .then((data) => {
        state.nodes = data.nodes || [];
        state.edges = data.edges || [];
        state.nodes.forEach((n) => {
          if (n.type === 'checkbox' && !n.items) n.items = getCheckboxItems(n);
        });
        state.view = data.view || { ...DEFAULT_VIEW };
        useFileBackend = true;
        connectCollab();
        if (cb) cb();
      })
      .catch((err) => {
        showMessage(
          'Could not reach backend. Run `node server.js` in the project folder, then open http://localhost:3751 in the browser (do not open index.html as a file). Changes will not be saved.',
          'warning'
        );
        if (cb) cb();
      });
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
        showMessage('Invalid JSON: ' + e.message, 'error');
      }
    };
    reader.readAsText(file);
  }


  function initToolbar() {
    $('btn-add-text').addEventListener('click', () => addNode('text'));
    $('btn-add-status').addEventListener('click', () => addNode('status'));
    $('btn-add-checkbox').addEventListener('click', () => addNode('checkbox'));
    $('btn-connect').addEventListener('click', connectSelected);
    $('btn-disconnect').addEventListener('click', disconnectSelected);
    $('btn-zoom-fit').addEventListener('click', zoomToFit);
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

    edgesLayer.addEventListener('mousedown', (e) => {
      const g = e.target.closest('[data-edge-id]');
      if (g) {
        e.preventDefault();
        e.stopPropagation();
        selectEdge(g.dataset.edgeId);
      } else {
        state.selectedEdgeId = null;
        render();
        renderProperties();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target;
        if ((target.closest('.node-text') && target.isContentEditable) || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        if (state.selectedEdgeId) {
          pushUndo();
          state.edges = state.edges.filter((ed) => ed.id !== state.selectedEdgeId);
          state.selectedEdgeId = null;
          render();
          persist();
          closeProperties();
          return;
        }
        deleteSelected();
      }
      if (e.key === 'Escape') selectOnly(null);
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        const target = e.target;
        if ((target.closest('.node-text') && target.isContentEditable) || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        const target = e.target;
        if ((target.closest('.node-text') && target.isContentEditable) || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        duplicateSelected();
      }
    });
  }


  initPanZoom();
  initToolbar();
  loadFromFile(() => { render(); zoomToFit(); });
})();
