# gen-figma

Minimal Figma-like canvas for one local page (e.g. TV dashboard). No Figma dependency; JSON document so tools/AI can edit the board.

## Run

Open `index.html` in a browser (file:// or any static server). No build.

## Usage

- **Pan:** Drag empty canvas. **Zoom:** Mouse wheel.
- **Text:** Toolbar “Text” → add text box. Drag to move; click to select; edit in panel or inline.
- **Status:** “Status” → colored block. In properties: label (WFM, RFR, App), color (red/yellow/green/black).
- **Arrows:** Select node A, then node B, then “Connect”. Arrow drawn A → B.
- **Delete:** Select node(s), press Delete/Backspace.
- **Undo/Redo:** Toolbar or expect keyboard shortcuts later.
- **Export JSON:** Download `board.json`. **Import JSON:** Load a saved board (overwrites current).

## Document format (for AI / scripts)

The board is a single JSON object. Export via “Export JSON” or read from localStorage key `gen-figma-board`.

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

- **In-browser:** Auto-save to `localStorage` on change.
- **File:** Use Export JSON / Import JSON. The exported file is the canonical board; edit it (or generate it) and re-import.
