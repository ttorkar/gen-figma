# gen-figma — context for AI

Local single-page Figma-like canvas (infinite canvas, draggable nodes, status blocks, arrows). No build; open `index.html` in a browser.

## Layout

- **`index.html`** — Toolbar, canvas wrapper, edges SVG, nodes layer, properties panel.
- **`css/main.css`** — Dot grid, node/panel styles, status colors.
- **`js/app.js`** — All app logic: state, pan/zoom, nodes, edges, selection, properties, undo/redo, persist.
- **`schema.json`** — JSON schema for the board document.
- **`board.json`** — Live board data when using the dev server; edit this file for AI-driven changes.
- **`server.js`** — Minimal Node server: serves static app + GET/POST `board.json`.
- **`README.md`** — User-facing run + usage + JSON format.

## Board document (JSON)

When running `node server.js`, the app loads and saves **`board.json`** (project root) only; no localStorage. Edit that file and refresh to see changes. Without the server, use Export/Import JSON. Structure:

```json
{
  "nodes": [
    { "id": "string", "type": "text|status", "x": 0, "y": 0, "width": 200, "height": 80, "text": "…", "color": "red|yellow|green|black", "label": "…" }
  ],
  "edges": [
    { "id": "string", "fromId": "nodeId", "toId": "nodeId" }
  ],
  "view": { "panX": 0, "panY": 0, "zoom": 1 }
}
```

- **Node types:** `text` (has `text`; optional `width`/`height`) and `status` (has `color`, `label`; optional `width`/`height`).
- **IDs:** Any unique string; app uses `id_` + random. Edges reference `node.id`.

To change the board via AI: edit **`board.json`** (when using the server) and user refreshes; or generate JSON and user uses “Import JSON”.

## Conventions in code

- `state` holds `nodes`, `edges`, `view`, `selection` (array of node ids), `undoStack`, `redoStack`.
- New nodes need unique `id`; edges need `fromId`/`toId` pointing at existing node ids.
- Positions are in “world” coordinates on the 8000×8000 canvas; `view` is pan/zoom only.
