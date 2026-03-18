// ============================================
// SUPER DASH BROS — Server
// Static files + Ghost/Leaderboard REST API + WebSocket Multiplayer
// ============================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const GHOST_DIR = path.join(__dirname, "data", "ghosts");
const LB_FILE = path.join(__dirname, "data", "leaderboard.json");

// Ensure data directories exist
if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"));
if (!fs.existsSync(GHOST_DIR)) fs.mkdirSync(GHOST_DIR);

// ============================================
// LEADERBOARD
// ============================================
let leaderboard = [];
try {
    if (fs.existsSync(LB_FILE)) leaderboard = JSON.parse(fs.readFileSync(LB_FILE, "utf8"));
} catch { /* start fresh */ }

function saveLeaderboard() {
    try { fs.writeFileSync(LB_FILE, JSON.stringify(leaderboard)); } catch {}
}

// ============================================
// HTTP SERVER
// ============================================
const MIME = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
};

function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
    });
}

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function jsonResp(res, code, data) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url.split("?")[0];

    // ── Ghost API ──
    const ghostMatch = url.match(/^\/api\/ghosts\/(\d+)$/);
    if (ghostMatch) {
        const seed = ghostMatch[1];
        const ghostFile = path.join(GHOST_DIR, `${seed}.json`);

        if (req.method === "GET") {
            try {
                if (fs.existsSync(ghostFile)) {
                    const data = JSON.parse(fs.readFileSync(ghostFile, "utf8"));
                    jsonResp(res, 200, data);
                } else {
                    jsonResp(res, 404, { error: "No ghost" });
                }
            } catch { jsonResp(res, 500, { error: "Read error" }); }
            return;
        }

        if (req.method === "POST") {
            const body = await readBody(req);
            if (!body || !body.frames || !body.completed) {
                jsonResp(res, 400, { error: "Invalid ghost data" });
                return;
            }
            // Only save if faster than existing
            try {
                if (fs.existsSync(ghostFile)) {
                    const existing = JSON.parse(fs.readFileSync(ghostFile, "utf8"));
                    if (existing.completed && existing.totalTime <= body.totalTime) {
                        jsonResp(res, 200, { saved: false, reason: "Existing ghost is faster" });
                        return;
                    }
                }
                fs.writeFileSync(ghostFile, JSON.stringify(body));
                jsonResp(res, 200, { saved: true });
            } catch { jsonResp(res, 500, { error: "Write error" }); }
            return;
        }
    }

    // ── Leaderboard API ──
    if (url === "/api/leaderboard" && req.method === "GET") {
        jsonResp(res, 200, leaderboard);
        return;
    }
    if (url === "/api/leaderboard" && req.method === "POST") {
        const body = await readBody(req);
        if (body && body.name && typeof body.time === "number" && typeof body.seed === "number") {
            leaderboard.push({ name: body.name, time: body.time, seed: body.seed, date: new Date().toISOString() });
            leaderboard.sort((a, b) => a.time - b.time);
            leaderboard = leaderboard.slice(0, 100);
            saveLeaderboard();
            jsonResp(res, 200, leaderboard);
        } else {
            jsonResp(res, 400, { error: "Invalid data" });
        }
        return;
    }

    // ── Static files ──
    let filePath = url === "/" ? "/index.html" : url;
    filePath = path.join(__dirname, filePath);
    const ext = path.extname(filePath);
    const mime = MIME[ext] || "application/octet-stream";

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
    });
});

// ============================================
// WEBSOCKET — Multiplayer Rooms
// ============================================
const wss = new WebSocketServer({ server });
const rooms = new Map();
const matchQueue = [];

function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms.has(code) ? generateCode() : code;
}

function broadcast(room, msg, excludeWs) {
    const data = JSON.stringify(msg);
    for (const p of room.players) {
        if (p && p.ws && p.ws.readyState === 1 && p.ws !== excludeWs) {
            p.ws.send(data);
        }
    }
}

function roomInfo(room) {
    return {
        code: room.code,
        seed: room.seed,
        state: room.state,
        players: room.players.map((p) => (p ? { name: p.name, character: p.character } : null)),
    };
}

function cleanupRoom(room) {
    if (room.players.every((p) => p === null)) {
        rooms.delete(room.code);
        console.log(`Room ${room.code} cleaned up`);
    }
}

wss.on("connection", (ws) => {
    ws._room = null;
    ws._playerIdx = -1;

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {
            case "create_room": {
                const code = generateCode();
                const seed = msg.seed || Math.floor(Math.random() * 2147483647);
                const room = {
                    code,
                    seed,
                    state: "waiting",
                    maxPlayers: 8,
                    players: [],
                    startTime: null,
                    finishedCount: 0,
                };
                const player = { ws, name: msg.name || "Player", character: msg.character || "k1", progress: 0, alive: true, finished: false, finishTime: null };
                room.players.push(player);
                rooms.set(code, room);
                ws._room = room;
                ws._playerIdx = 0;
                ws.send(JSON.stringify({ type: "room_created", code, seed, index: 0, room: roomInfo(room) }));
                console.log(`Room ${code} created by ${player.name}`);
                break;
            }

            case "join_room": {
                const code = (msg.code || "").toUpperCase();
                const room = rooms.get(code);
                if (!room) { ws.send(JSON.stringify({ type: "error", message: "Room not found" })); return; }
                if (room.state !== "waiting") { ws.send(JSON.stringify({ type: "error", message: "Race already started" })); return; }
                if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type: "error", message: "Room is full" })); return; }

                const player = { ws, name: msg.name || "Player", character: msg.character || "k1", progress: 0, alive: true, finished: false, finishTime: null };
                room.players.push(player);
                ws._room = room;
                ws._playerIdx = room.players.length - 1;
                ws.send(JSON.stringify({ type: "room_joined", code, seed: room.seed, index: ws._playerIdx, room: roomInfo(room) }));
                broadcast(room, { type: "player_joined", index: ws._playerIdx, name: player.name, character: player.character, room: roomInfo(room) }, ws);
                console.log(`Room ${code}: ${player.name} joined (${room.players.length} players)`);
                break;
            }

            case "quick_match": {
                // Remove if already in queue
                const qIdx = matchQueue.findIndex((q) => q.ws === ws);
                if (qIdx !== -1) matchQueue.splice(qIdx, 1);

                if (matchQueue.length > 0) {
                    const other = matchQueue.shift();
                    if (other.ws.readyState !== 1) {
                        // Other disconnected, re-queue self
                        matchQueue.push({ ws, name: msg.name, character: msg.character });
                        ws.send(JSON.stringify({ type: "queue_waiting" }));
                        break;
                    }
                    // Create room with both
                    const code = generateCode();
                    const seed = Math.floor(Math.random() * 2147483647);
                    const room = {
                        code, seed, state: "waiting", maxPlayers: 8, players: [], startTime: null, finishedCount: 0,
                    };
                    const p1 = { ws: other.ws, name: other.name || "Player", character: other.character || "k1", progress: 0, alive: true, finished: false, finishTime: null };
                    const p2 = { ws, name: msg.name || "Player", character: msg.character || "k1", progress: 0, alive: true, finished: false, finishTime: null };
                    room.players.push(p1, p2);
                    rooms.set(code, room);
                    other.ws._room = room;
                    other.ws._playerIdx = 0;
                    ws._room = room;
                    ws._playerIdx = 1;
                    other.ws.send(JSON.stringify({ type: "room_joined", code, seed, index: 0, room: roomInfo(room) }));
                    ws.send(JSON.stringify({ type: "room_joined", code, seed, index: 1, room: roomInfo(room) }));
                    broadcast(room, { type: "player_joined", room: roomInfo(room) });
                    console.log(`Quick match: Room ${code} created for ${p1.name} vs ${p2.name}`);
                } else {
                    matchQueue.push({ ws, name: msg.name, character: msg.character });
                    ws.send(JSON.stringify({ type: "queue_waiting" }));
                }
                break;
            }

            case "start_race": {
                const room = ws._room;
                if (!room || room.state !== "waiting") return;
                if (ws._playerIdx !== 0) return; // Only host can start
                if (room.players.length < 2) { ws.send(JSON.stringify({ type: "error", message: "Need at least 2 players" })); return; }

                room.state = "countdown";
                room.startTime = Date.now() + 3500; // 3s countdown + buffer
                broadcast(room, { type: "race_countdown", startTime: room.startTime, seed: room.seed });
                setTimeout(() => {
                    if (room.state === "countdown") {
                        room.state = "racing";
                        broadcast(room, { type: "race_go" });
                    }
                }, 3500);
                console.log(`Room ${room.code}: race starting in 3s`);
                break;
            }

            case "player_update": {
                const room = ws._room;
                if (!room || room.state !== "racing") return;
                const idx = ws._playerIdx;
                const p = room.players[idx];
                if (p) {
                    p.progress = msg.progress || 0;
                    p.y = msg.y;
                }
                broadcast(room, { type: "remote_update", index: idx, progress: msg.progress, y: msg.y, jumping: msg.jumping }, ws);
                break;
            }

            case "player_jump": {
                const room = ws._room;
                if (!room || room.state !== "racing") return;
                broadcast(room, { type: "remote_jump", index: ws._playerIdx }, ws);
                break;
            }

            case "player_died": {
                const room = ws._room;
                if (!room || room.state !== "racing") return;
                const p = room.players[ws._playerIdx];
                if (p) { p.alive = false; p.progress = msg.progress || 0; }
                broadcast(room, { type: "remote_died", index: ws._playerIdx, progress: msg.progress }, ws);
                checkRaceEnd(room);
                break;
            }

            case "player_finished": {
                const room = ws._room;
                if (!room || room.state !== "racing") return;
                const p = room.players[ws._playerIdx];
                if (p && !p.finished) {
                    room.finishedCount++;
                    p.finished = true;
                    p.finishTime = msg.time;
                    p.progress = 1;
                }
                broadcast(room, { type: "remote_finished", index: ws._playerIdx, time: msg.time, place: room.finishedCount }, ws);
                ws.send(JSON.stringify({ type: "your_place", place: room.finishedCount }));
                checkRaceEnd(room);
                break;
            }

            case "leave_room": {
                leaveRoom(ws);
                break;
            }
        }
    });

    ws.on("close", () => {
        // Remove from match queue
        const qIdx = matchQueue.findIndex((q) => q.ws === ws);
        if (qIdx !== -1) matchQueue.splice(qIdx, 1);
        leaveRoom(ws);
    });
});

function leaveRoom(ws) {
    const room = ws._room;
    if (!room) return;
    const idx = ws._playerIdx;
    if (idx >= 0 && idx < room.players.length) {
        const name = room.players[idx] ? room.players[idx].name : "?";
        room.players[idx] = null;
        broadcast(room, { type: "player_left", index: idx, name });
    }
    ws._room = null;
    ws._playerIdx = -1;

    if (room.state === "racing") checkRaceEnd(room);
    cleanupRoom(room);
}

function checkRaceEnd(room) {
    const active = room.players.filter((p) => p !== null);
    const allDone = active.every((p) => p.finished || !p.alive);
    if (allDone && active.length > 0) {
        room.state = "finished";
        const results = active
            .map((p, i) => ({ name: p.name, character: p.character, finished: p.finished, time: p.finishTime, progress: p.progress }))
            .sort((a, b) => {
                if (a.finished && !b.finished) return -1;
                if (!a.finished && b.finished) return 1;
                if (a.finished && b.finished) return a.time - b.time;
                return b.progress - a.progress;
            });
        broadcast(room, { type: "race_results", results });
        console.log(`Room ${room.code}: race finished`);
    }
}

server.listen(PORT, () => {
    console.log(`Super Dash Bros running on http://localhost:${PORT}`);
});
