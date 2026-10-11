// Chatterbox accounts + chat history server.
//
// Runs next to the Bonezegei chat relay (app.bzg). The relay still carries the live
// chat; this small server only does two things:
//   1. Accounts: sign up / log in. New users are written to database/users.js
//   2. Chat logs: every sent message is written to database/chatlogs.js, and
//      handed back to people when they log in.
//
// It ALSO forwards everything that isn't /api/... (the web page and the live chat
// WebSocket) to the Bonezegei server on port 8000. That means port 8001 on its own
// serves the whole app, so ONE tunnel is enough:   ngrok http 8001
//
// No packages needed, just Node.js:   node server/accounts.js
//
// Personal project: passwords are stored as plain text and the "session" is a
// random token kept in memory. Not meant for the open internet.

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 8001;
const CHAT_PORT = 8000;        // the Bonezegei server (app.bzg)
const DB_DIR = path.join(__dirname, "..", "database");
const USERS_FILE = path.join(DB_DIR, "users.js");
const LOGS_FILE = path.join(DB_DIR, "chatlogs.js");

const CHANNELS = ["general", "random", "help", "memes"];   // keep in sync with public/app.js
const MAX_TEXT = 300;          // same limit as the message box
const HISTORY_PER_CHANNEL = 300;   // how many past messages a person gets on login

// ---------- the "database": two plain .js files ----------
fs.mkdirSync(DB_DIR, { recursive: true });

// Writes `module.exports = <data>;` so the file is itself a valid JS module.
function saveModule(file, header, data) {
    const body = header + "\nmodule.exports = " + JSON.stringify(data, null, 2) + ";\n";
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);   // swap in one step so a crash can't leave half a file
}

function loadModule(file, fallback, header) {
    if (!fs.existsSync(file)) {
        saveModule(file, header, fallback);
        return fallback;
    }
    delete require.cache[require.resolve(file)];
    return require(file);
}

const USERS_HEADER =
    "// Chatterbox user accounts. Rewritten by server/accounts.js every time someone signs up.\n" +
    "// Each entry: id, username, password, createdAt (ms since 1970), createdAtText.";
const LOGS_HEADER =
    "// Chatterbox chat logs, one list per channel. Rewritten by server/accounts.js\n" +
    "// every time a message is sent. Each entry: id, user, text, ts (ms since 1970).";

const users = loadModule(USERS_FILE, [], USERS_HEADER);
const emptyLogs = () => Object.fromEntries(CHANNELS.map((c) => [c, []]));
const logs = loadModule(LOGS_FILE, emptyLogs(), LOGS_HEADER);
CHANNELS.forEach((c) => { if (!Array.isArray(logs[c])) logs[c] = []; });

const sessions = new Map();   // token -> username (cleared when this server restarts)

// ---------- helpers ----------
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function reply(res, code, body) {
    res.writeHead(code, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",           // the page is served from another port
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    res.end(JSON.stringify(body));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 20000) { reject(new Error("Request too large")); req.destroy(); }
        });
        req.on("end", () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(new Error("Bad JSON")); }
        });
        req.on("error", reject);
    });
}

function userFor(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    return m ? sessions.get(m[1]) || null : null;
}

function startSession(username) {
    const token = crypto.randomBytes(16).toString("hex");
    sessions.set(token, username);
    return token;
}

// ---------- routes ----------
async function signup(req, res) {
    const { username, password, confirm } = await readJson(req);
    const name = String(username || "").trim();
    if (name.length < 2 || name.length > 16) return reply(res, 400, { error: "Username needs 2 to 16 characters." });
    if (name.indexOf("|") >= 0) return reply(res, 400, { error: "Usernames can't contain |" });
    if (!password) return reply(res, 400, { error: "Please choose a password." });
    if (password !== confirm) return reply(res, 400, { error: "Passwords don't match." });
    if (users.some((u) => same(u.username, name))) return reply(res, 409, { error: "That username is already registered." });

    const now = Date.now();
    users.push({
        id: users.length ? Math.max(...users.map((u) => u.id)) + 1 : 1,
        username: name,
        password: String(password),
        createdAt: now,
        createdAtText: new Date(now).toISOString()
    });
    saveModule(USERS_FILE, USERS_HEADER, users);   // <- the database file updates here
    console.log("New user confirmed: " + name);
    reply(res, 200, { username: name, token: startSession(name) });
}

async function login(req, res) {
    const { username, password } = await readJson(req);
    const user = users.find((u) => same(u.username, String(username || "").trim()));
    if (!user || user.password !== String(password || "")) {
        return reply(res, 401, { error: "Wrong username or password." });
    }
    reply(res, 200, { username: user.username, token: startSession(user.username) });
}

function history(req, res) {
    if (!userFor(req)) return reply(res, 401, { error: "Please log in again." });
    const out = {};
    CHANNELS.forEach((c) => { out[c] = logs[c].slice(-HISTORY_PER_CHANNEL); });
    reply(res, 200, out);
}

async function saveMessage(req, res) {
    const user = userFor(req);
    if (!user) return reply(res, 401, { error: "Please log in again." });
    const { channel, text } = await readJson(req);
    const clean = String(text || "").slice(0, MAX_TEXT);
    if (CHANNELS.indexOf(channel) < 0 || !clean.trim()) return reply(res, 400, { error: "Bad message." });

    const list = logs[channel];
    list.push({ id: (list.length ? list[list.length - 1].id : 0) + 1, user, text: clean, ts: Date.now() });
    saveModule(LOGS_FILE, LOGS_HEADER, logs);
    reply(res, 200, { ok: true });
}

const routes = {
    "POST /api/signup": signup,
    "POST /api/login": login,
    "GET /api/history": history,
    "POST /api/messages": saveMessage
};

// ---------- forward the page + live chat to the Bonezegei server ----------
function proxyPage(req, res) {
    const up = http.request(
        { host: "127.0.0.1", port: CHAT_PORT, path: req.url, method: req.method,
          headers: { ...req.headers, connection: "close" } },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    up.on("error", () => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("The chat server (app.bzg, port " + CHAT_PORT + ") isn't running.");
    });
    req.pipe(up);
}

function proxySocket(req, socket, head) {
    const up = net.connect(CHAT_PORT, "127.0.0.1", () => {
        let raw = req.method + " " + req.url + " HTTP/1.1\r\n";
        for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ": " + req.rawHeaders[i + 1] + "\r\n";
        up.write(raw + "\r\n");
        if (head && head.length) up.write(head);
        socket.pipe(up);
        up.pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
}

const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith("/api/")) return proxyPage(req, res);
    if (req.method === "OPTIONS") return reply(res, 204, {});
    const handler = routes[req.method + " " + req.url.split("?")[0]];
    if (!handler) return reply(res, 404, { error: "Not found" });
    try {
        await handler(req, res);
    } catch (err) {
        reply(res, 400, { error: err.message });
    }
});
server.on("upgrade", proxySocket);
server.listen(PORT, () => {
    console.log("Chatterbox accounts server on port " + PORT + " (open http://localhost:" + PORT + " for the whole app)");
    console.log(users.length + " registered user(s). Database: " + DB_DIR);
    console.log("Forwarding the page and live chat to port " + CHAT_PORT + ". For ngrok use: ngrok http " + PORT);
});
