const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3751;
const BOARD_FILE = path.join(__dirname, 'board.json');
const DEFAULT_BOARD = '{"nodes":[],"edges":[],"view":{"panX":80,"panY":80,"zoom":1}}';

const MIMES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

// Single source of truth for collaboration; loaded at startup, updated on POST, broadcast on change
let boardJson = DEFAULT_BOARD;

function loadBoardFromFile() {
  try {
    const data = fs.readFileSync(BOARD_FILE, 'utf8');
    if (data && data.trim()) {
      JSON.parse(data);
      boardJson = data;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Board load:', e.message);
  }
}

function broadcastBoard() {
  const raw = boardJson;
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(raw);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;

  if (req.method === 'GET' && url === '/board.json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    res.end(boardJson);
    return;
  }

  if (req.method === 'POST' && url === '/board.json') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        JSON.parse(body);
        boardJson = body;
        fs.writeFile(BOARD_FILE, body, 'utf8', (err) => {
          if (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.writeHead(200);
          res.end('{}');
          broadcastBoard();
        });
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'OPTIONS' && (url === '/board.json' || url === '/index.html')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    res.end();
    return;
  }

  const filePath = path.join(__dirname, url.replace(/^\//, ''));
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err || !MIMES[ext]) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', MIMES[ext]);
    res.writeHead(200);
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.send(boardJson);
});

loadBoardFromFile();
server.listen(PORT, () => {
  console.log(`gen-figma: http://localhost:${PORT}`);
  console.log('Board file: board.json (load/save when using this server)');
  console.log('Collaborative: all open tabs receive updates in real time.');
});
