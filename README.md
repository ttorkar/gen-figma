# gen-figma

Minimal Figma-like canvas for one local page (e.g. TV dashboard). No Figma dependency; JSON document so tools/AI can edit the board.

## Run

- **With file board (recommended):** `npm install` then `node server.js` (or `npm start`), then open http://localhost:3751. The app loads and saves **`board.json`** in the project folder. No localStorage.
- **Without server:** Open `index.html` (file:// or static server). No auto-save; use Export/Import JSON to save or load a file.

## Usage

- **Pan:** Drag empty canvas. **Zoom:** Mouse wheel.
- **Text:** Toolbar “Text” → add text box. Drag to move; click to select; edit in panel or inline.
- **Status:** “Status” → colored block. In properties: label (WFM, RFR, App), color (red/yellow/green/black).
- **Arrows:** Select node A, then node B, then “Connect”. Arrow drawn A → B.
- **Delete:** Select node(s), press Delete/Backspace.
- **Undo/Redo:** Toolbar or expect keyboard shortcuts later.
- **Export JSON:** Download `board.json`. **Import JSON:** Load a saved board (overwrites current).

## Document format (for AI / scripts)

The board is a single JSON object. When using the dev server (`node server.js`), the live file is **`board.json`** in the project root—edit it and refresh the app. Otherwise use Export/Import JSON.

```json
{
  "nodes": [
    { "id": "id_abc", "type": "text", "x": 100, "y": 100, "width": 200, "height": 80, "text": "Quote of the day" },
    { "id": "id_def", "type": "status", "x": 100, "y": 200, "width": 140, "height": 44, "color": "yellow", "label": "RFR" }
  ],
  "edges": [
    { "id": "id_xyz", "fromId": "id_abc", "toId": "id_def" }
  ],
  "view": { "panX": 80, "panY": 80, "zoom": 1 }
}
```

- **nodes[].type:** `"text"` (title, bullets, legend) or `"status"` (colored block).
- **nodes[].color:** Only for status: `"red"` | `"yellow"` | `"green"` | `"black"`.
- **edges:** `fromId` → `toId` (arrow from first node to second).

Full schema: `schema.json`.

## Persistence

- **With server:** Board lives in **`board.json`** only. Load on startup (GET), auto-save on change (POST, debounced). Edit `board.json` with AI or an editor, then refresh.
- **Without server:** No auto-save. Use Export JSON / Import JSON to save or load a file.

## Collaboration

With the server running, open the same URL in multiple tabs (or different devices on the same LAN). Every save is broadcast over WebSocket; all clients get the latest nodes and edges. Last write wins. Pan/zoom stay local per tab.
