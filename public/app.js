// Chatterbox client. Loaded by index.html (must come after the page markup).

// ---------- connection ----------
const wsUrl = location.protocol.indexOf("http") === 0
    ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host
    : "ws://localhost:8000";

const AVATAR_COLORS = ["#35D07F", "#FF6FA5", "#5CCBFF", "#FF8A2B", "#8B5CF6"];
const CLAIM_MS = 700;        // how long we wait for "taken" replies
const HEARTBEAT_MS = 20000;  // how often we say "still here"
const STALE_MS = 150000;     // forget people we haven't heard from
const TYPING_REFRESH_MS = 2500; // how often we repeat "I'm typing"
const TYPING_IDLE_MS = 3000;    // stop saying it after this much silence
const TYPING_TTL_MS = 5000;     // hide someone's dots if we hear nothing for this long
const GROUP_MS = 5 * 60 * 1000; // messages from one person within 5 minutes are grouped

// Pictures. If pictures never arrive on your server, lower CHUNK_CHARS (try 800, then 400).
const MAX_DIM = 1024;                     // longest side of a sent picture, in pixels
const MAX_IMG_BYTES = 160 * 1024;         // a sent picture is squeezed to fit under this
const MAX_RECV_BYTES = 400 * 1024;        // refuse bigger incoming pictures
const CHUNK_CHARS = 1500;                 // size of one packet of picture data
const CHUNK_PACKET_DELAY_MS = 5;          // short pause every few packets, to be gentle on the server
const TRANSFER_TIMEOUT_MS = 15000;        // give up on a picture if nothing arrives for this long
const MAX_STORE_BYTES = 40 * 1024 * 1024; // pictures kept in memory; the oldest are dropped past this
const MIN_LOADING_MS = 350;               // so the loading animation is visible when a picture reloads
const HIDDEN_UNLOAD_MS = 5000;            // free pictures when the tab has been hidden this long
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// The channels are fixed. Add or rename them here.
const CHANNELS = [
    { id: "general", topic: "Say hi and hang out" },
    { id: "random", topic: "Anything goes" },
    { id: "help", topic: "Stuck on something? Ask here" },
    { id: "memes", topic: "Only the good stuff" }
];

const $ = (id) => document.getElementById(id);
const joinScreen = $("joinScreen"), chatScreen = $("chatScreen");
const nameInput = $("nameInput"), joinBtn = $("joinBtn"), joinError = $("joinError");
const msgInput = $("msgInput"), sendBtn = $("sendBtn");
const logEl = $("log"), usersEl = $("users"), countEl = $("count");
const panel = $("panel"), whoBtn = $("whoBtn"), chanBtn = $("chanBtn");
const channelsEl = $("channels"), channelList = $("channelList"), scrim = $("scrim");
const chanNameEl = $("chanName"), chanTopicEl = $("chanTopic");
const welcomeEl = $("welcome"), welcomeTitle = $("welcomeTitle"), welcomeText = $("welcomeText");
const typingEl = $("typing"), typingText = $("typingText");
const attachBtn = $("attachBtn"), fileInput = $("fileInput"), dropHint = $("dropHint");
const lightbox = $("lightbox"), lbImg = $("lbImg");
const consoleEl = $("console"), consoleBody = $("consoleBody"), consoleToggle = $("consoleToggle");

// ---------- console (shows what travels over the socket) ----------
const PACKET_TYPES = ["CLAIM", "TAKEN", "HELLO", "HERE", "BYE", "MSG", "TYPING", "IMGH", "IMGC"];
const QUIET_TYPES = ["TYPING", "IMGC"];   // packets too chatty to list in the console
let warnedUnknown = false;
const TAG_CLASS = { System: "t-sys", Server: "t-srv", Client: "t-cli" };

function logLine(tag, text) {
    try { writeLine(tag, text); } catch (err) { /* logging must never break the chat */ }
}

function writeLine(tag, text) {
    const stick = consoleBody.scrollHeight - consoleBody.scrollTop - consoleBody.clientHeight < 40;
    const line = document.createElement("span");
    line.className = "cl";
    const label = document.createElement("b");
    label.className = "tag " + TAG_CLASS[tag];
    label.textContent = "[" + tag + "]";
    line.append(label, " " + text);
    consoleBody.appendChild(line);
    while (consoleBody.childElementCount > 200) consoleBody.firstElementChild.remove();
    if (stick) consoleBody.scrollTop = consoleBody.scrollHeight;
}

// Position state (declared before placeConsole uses it)
const POS_KEY = "chatterbox.console";
let userPlaced = false;   // true once the console has been dragged somewhere
let drag = null;
let suppressClick = false;

// Keep the console just above the message box on the chat screen,
// unless the user has moved it somewhere else.
function placeConsole() {
    if (userPlaced) { clampConsole(); return; }
    const bar = $("chatForm");
    const chatOn = chatScreen.classList.contains("active");
    const lift = chatOn ? bar.offsetHeight : 0;
    // On wide screens, start just right of the channel column.
    const wide = window.matchMedia ? window.matchMedia("(min-width: 901px)").matches : false;
    const side = chatOn && wide ? channelsEl.offsetWidth : 0;
    consoleEl.style.left = (side + 14) + "px";
    consoleEl.style.bottom = (lift + 14) + "px";
}
window.addEventListener("resize", placeConsole);
if (window.ResizeObserver) new ResizeObserver(placeConsole).observe($("chatForm"));

consoleToggle.addEventListener("click", () => {
    if (suppressClick) return; // this click was the end of a drag
    const open = consoleEl.classList.toggle("open");
    consoleBody.hidden = !open;
    consoleToggle.setAttribute("aria-expanded", open);
    if (open) consoleBody.scrollTop = consoleBody.scrollHeight;
    if (userPlaced) clampConsole(); // opening makes it taller: keep it on screen
});
$("consoleClear").addEventListener("click", () => consoleBody.replaceChildren());

// ---------- draggable console ----------
const consoleBar = consoleEl.querySelector(".console-bar");
const consoleGrip = $("consoleGrip");

// Keep the whole window inside the browser window.
function clampConsole() {
    const r = consoleEl.getBoundingClientRect();
    const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
    const top = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - r.height));
    consoleEl.style.left = left + "px";
    consoleEl.style.top = top + "px";
}

function setConsolePos(left, top) {
    userPlaced = true;
    consoleEl.style.left = left + "px";
    consoleEl.style.top = top + "px";
    consoleEl.style.bottom = "auto";
    clampConsole();
}

function savePos() {
    try {
        const r = consoleEl.getBoundingClientRect();
        localStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top }));
    } catch (err) { /* storage unavailable: position just won't be remembered */ }
}

function resetPos() {
    userPlaced = false;
    consoleEl.style.left = "";
    consoleEl.style.top = "";
    try { localStorage.removeItem(POS_KEY); } catch (err) { }
    placeConsole();
}

function onDragMove(e) {
    if (!drag) return;
    if (!drag.moved) {
        // ignore tiny wiggles so a normal click still toggles the console
        if (Math.abs(e.clientX - drag.startX) < 4 && Math.abs(e.clientY - drag.startY) < 4) return;
        drag.moved = true;
        consoleEl.classList.add("dragging");
    }
    setConsolePos(e.clientX - drag.offX, e.clientY - drag.offY);
}

function onDragEnd() {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    if (drag && drag.moved) {
        consoleEl.classList.remove("dragging");
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 80);
        savePos();
    }
    drag = null;
}

consoleBar.addEventListener("pointerdown", (e) => {
    if (e.button > 0 || e.target.closest("#consoleClear")) return;
    const r = consoleEl.getBoundingClientRect();
    drag = { offX: e.clientX - r.left, offY: e.clientY - r.top, startX: e.clientX, startY: e.clientY, moved: false };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
});

// Keyboard: arrow keys move it (Shift for bigger steps), Escape or double-click resets it.
consoleGrip.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Home") { e.preventDefault(); resetPos(); return; }
    const step = e.shiftKey ? 60 : 20;
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!move) return;
    e.preventDefault();
    const r = consoleEl.getBoundingClientRect();
    setConsolePos(r.left + move[0], r.top + move[1]);
    savePos();
});
consoleGrip.addEventListener("dblclick", resetPos);

// Remember where it was last time.
try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    if (saved && isFinite(saved.left) && isFinite(saved.top)) setConsolePos(saved.left, saved.top);
} catch (err) { }

// Every tab gets its own id, so two people can never be confused.
const myId = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

let socket = null;
let retryTimer = null;
let retryDelay = 1000;
let state = "connecting";
let joined = false;
let myName = "";
let claim = null;            // { name, timer } while we wait to see if a name is free
const peers = new Map();     // id -> { name, seen }
const typers = new Map();    // id -> { name, ch, timer }  (people typing right now)
let iAmTyping = false;
let typingChannel = "general";
let typingSentAt = 0;
let typingIdleTimer = null;

// Channel state. Every browser receives every message and keeps its own copy.
const store = {};            // channel id -> { items: [], unread: 0, mentions: 0 }
const drafts = {};           // channel id -> unsent text in the message box
let current = "general";
CHANNELS.forEach((c) => { store[c.id] = { items: [], unread: 0, mentions: 0 }; drafts[c.id] = ""; });

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function setStatus(next) {
    state = next;
    const label = { online: "Connected", connecting: "Connecting", offline: "Offline" }[state];
    [$("joinStatus"), $("chatStatus")].forEach((el) => {
        el.dataset.state = state;
        el.querySelector(".txt").textContent = label;
    });
    const online = state === "online";
    const checking = claim !== null;
    nameInput.disabled = !online || checking;
    joinBtn.disabled = !online || checking;
    joinBtn.textContent = checking ? "Checking..." : "Join chat";
    msgInput.disabled = !(online && joined);
    sendBtn.disabled = !(online && joined);
    attachBtn.disabled = !(online && joined);
}

// Every packet looks like  TYPE|id|name|payload
// For MSG the payload is  channel|text   and for TYPING it is  channel|1  or  channel|0
function sendPacket(type, id, name, payload) {
    return sendRaw(type + "|" + id + "|" + name + "|" + (payload || ""));
}

function sendRaw(text) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(text);
        const m = parse(text);
        if (QUIET_TYPES.indexOf(m.type) < 0) {
            if (m.type === "MSG") {
                const msg = splitPayload(m.payload);
                logLine("Client", "#" + msg.ch + " " + msg.text);
            } else if (m.type === "IMGH") {
                const hd = splitPayload(m.payload);
                const f = hd.text.split("|");
                logLine("Client", "#" + hd.ch + " picture, " + Math.round(f[3] / 1024) + " KB in " + f[1] + " packets");
            } else {
                logLine("Client", text);
            }
        }
        return true;
    }
    return false;
}

function parse(data) {
    const parts = [];
    let rest = data;
    for (let i = 0; i < 3; i++) {
        const k = rest.indexOf("|");
        if (k < 0) { parts.push(rest); rest = ""; continue; }
        parts.push(rest.slice(0, k));
        rest = rest.slice(k + 1);
    }
    parts.push(rest);
    return { type: parts[0], id: parts[1], name: parts[2], payload: parts[3] };
}

// "random|hello"  ->  { ch: "random", text: "hello" }
// No known channel in front (older page)  ->  #general
function splitPayload(payload) {
    const k = payload.indexOf("|");
    if (k > 0) {
        const ch = payload.slice(0, k);
        if (store[ch]) return { ch, text: payload.slice(k + 1) };
    }
    return { ch: "general", text: payload };
}

function connect() {
    setStatus("connecting");
    logLine("System", "Connecting to " + wsUrl + " ...");
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        clearTimeout(retryTimer);
        retryDelay = 1000;
        logLine("System", "Handshake complete. WebSocket ready.");
        setStatus("online");
        if (joined) {
            // Connection came back: tell everyone we're still here.
            resetPeers();
            sendPacket("HELLO", myId, myName, "re");
            addSystem("Reconnected.", current);
        } else {
            nameInput.focus();
        }
    };

    socket.onmessage = (event) => {
        let data = String(event.data);

        // The original lab server wraps every message as "User <n> says: <text>".
        // Unwrap it so the chat still works if that server is running.
        const wrapped = /^User \d+ says: ([\s\S]*)$/.exec(data);
        if (wrapped) data = wrapped[1];

        const m = parse(data);
        if (QUIET_TYPES.indexOf(m.type) < 0) {
            if (m.type === "MSG") {
                const msg = splitPayload(m.payload);
                logLine("Server", m.name + " says in #" + msg.ch + ": " + msg.text);
            } else if (m.type === "IMGH") {
                const hd = splitPayload(m.payload);
                logLine("Server", m.name + " sent a picture in #" + hd.ch + " (" + Math.round(hd.text.split("|")[3] / 1024) + " KB)");
            } else {
                logLine("Server", data);
            }
        }

        if (PACKET_TYPES.indexOf(m.type) < 0) {
            if (!warnedUnknown) {
                warnedUnknown = true;
                logLine("System", "Ignored a message that isn't a Chatterbox packet. If the chat stays empty, make sure the server is running the new app.bzg.");
            }
            return;
        }
        handle(data);
    };

    socket.onclose = () => {
        if (claim) { clearTimeout(claim.timer); claim = null; }
        cancelTyping();
        clearAllTypers();
        setStatus("offline");
        logLine("System", "Connection closed. Retrying in " + (retryDelay / 1000) + "s ...");
        if (joined) addSystem("Connection lost. Trying to reconnect...", current);
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
    };

    socket.onerror = () => logLine("System", "Connection error.");
}

// ---------- protocol ----------
function handle(data) {
    const m = parse(data);

    // Username checks work before we have joined.
    if (m.type === "CLAIM") {
        if (m.id === myId) return;
        const owner = joined && same(m.name, myName);
        // If two people claim the same name at once, the lower id wins.
        const tie = claim && same(m.name, claim.name) && myId < m.id;
        if (owner || tie) sendPacket("TAKEN", m.id, m.name, "");
        return;
    }
    if (m.type === "TAKEN") {
        if (claim && m.id === myId && same(m.name, claim.name)) failClaim();
        return;
    }

    if (!joined) return;

    if (m.type === "HELLO") {
        addPeer(m.id, m.name);
        if (m.payload !== "re") addSystem(m.name + " joined the chat", "general");
        if (m.id !== myId) sendPacket("HERE", myId, myName, "");
    } else if (m.type === "HERE") {
        addPeer(m.id, m.name);
    } else if (m.type === "TYPING") {
        if (m.id !== myId) {
            const t = splitPayload(m.payload);
            setTyper(m.id, m.name, t.ch, t.text === "1");
        }
    } else if (m.type === "BYE") {
        clearTyper(m.id);
        if (peers.delete(m.id)) {
            renderUsers();
            addSystem(m.name + " left the chat", "general");
        }
    } else if (m.type === "MSG") {
        const msg = splitPayload(m.payload);
        clearTyper(m.id);
        addPeer(m.id, m.name);
        receiveMessage(msg.ch, m.id, m.name, msg.text);
    } else if (m.type === "IMGH") {
        onImageHeader(m);
    } else if (m.type === "IMGC") {
        onImageChunk(m);
    }
}

function resetPeers() {
    clearAllTypers();
    peers.clear();
    peers.set(myId, { name: myName, seen: Date.now() });
    renderUsers();
}

function addPeer(id, name) {
    const known = peers.get(id);
    peers.set(id, { name, seen: Date.now() });
    if (!known || known.name !== name) renderUsers();
}

// ---------- typing indicator (per channel) ----------
// What we send: TYPING|id|name|channel|1 while typing, channel|0 when we stop.
function stopTyping() {
    clearTimeout(typingIdleTimer);
    if (iAmTyping) {
        iAmTyping = false;
        sendPacket("TYPING", myId, myName, typingChannel + "|0");
    }
}

// Used after sending a message or losing the connection: others hide our dots
// on their own, so no extra packet is needed.
function cancelTyping() {
    clearTimeout(typingIdleTimer);
    iAmTyping = false;
}

msgInput.addEventListener("input", () => {
    if (!joined) return;
    if (iAmTyping && typingChannel !== current) stopTyping();
    if (msgInput.value.trim() === "") { stopTyping(); return; }
    const now = Date.now();
    if (!iAmTyping || now - typingSentAt > TYPING_REFRESH_MS) {
        typingChannel = current;
        sendPacket("TYPING", myId, myName, current + "|1");
        typingSentAt = now;
        iAmTyping = true;
    }
    clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
});

// What we receive
function setTyper(id, name, ch, on) {
    const existed = typers.get(id);
    if (existed) clearTimeout(existed.timer);
    if (!on) {
        if (existed) { typers.delete(id); renderTyping(); }
        return;
    }
    typers.set(id, { name, ch, timer: setTimeout(() => clearTyper(id), TYPING_TTL_MS) });
    if (!existed || existed.name !== name || existed.ch !== ch) renderTyping();
}

function clearTyper(id) {
    const t = typers.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    typers.delete(id);
    renderTyping();
}

function clearAllTypers() {
    typers.forEach((t) => clearTimeout(t.timer));
    typers.clear();
    renderTyping();
}

function typingLabel(names) {
    if (names.length === 1) return names[0] + " is typing";
    if (names.length === 2) return names[0] + " and " + names[1] + " are typing";
    if (names.length === 3) return names[0] + ", " + names[1] + " and " + names[2] + " are typing";
    return "Several people are typing";
}

// Only people typing in the channel you are looking at are shown.
function renderTyping() {
    const names = Array.from(typers.values()).filter((t) => t.ch === current).map((t) => t.name);
    if (names.length === 0) {
        typingEl.hidden = true;
        return;
    }
    const stick = nearBottom();
    typingText.textContent = typingLabel(names);
    typingEl.hidden = false;
    if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function startClaim(name) {
    claim = { name, timer: setTimeout(finishClaim, CLAIM_MS) };
    joinError.hidden = true;
    setStatus(state);
    sendPacket("CLAIM", myId, name, "");
}

function failClaim() {
    clearTimeout(claim.timer);
    claim = null;
    setStatus(state);
    showJoinError("That username is taken. Try another one.");
}

function finishClaim() {
    if (!claim) return;
    myName = claim.name;
    claim = null;
    joined = true;
    logLine("System", "Username accepted. Joined as " + myName + ".");
    $("meName").textContent = myName;
    $("meAvatar").style.background = colorFor(myName);
    $("meAvatar").textContent = myName.charAt(0).toUpperCase();
    resetPeers();
    showScreen("chat");
    setStatus(state);
    sendPacket("HELLO", myId, myName, "");
    msgInput.focus();
}

// Say "still here" now and then, and forget people who went quiet.
setInterval(() => {
    if (!joined) return;
    sendPacket("HERE", myId, myName, "");
    const now = Date.now();
    peers.forEach((p, id) => {
        if (id !== myId && now - p.seen > STALE_MS) {
            peers.delete(id);
            addSystem(p.name + " left the chat", "general");
        }
    });
    renderUsers();
}, HEARTBEAT_MS);

// Best effort goodbye when the tab closes.
window.addEventListener("pagehide", () => {
    if (joined) sendPacket("BYE", myId, myName, "");
});

// ---------- UI helpers ----------
function showScreen(name) {
    joinScreen.classList.toggle("active", name === "join");
    chatScreen.classList.toggle("active", name === "chat");
    placeConsole();
}

function colorFor(name) {
    let sum = 0;
    for (let c = 0; c < name.length; c++) sum += name.charCodeAt(c);
    return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function makeAvatar(name) {
    const a = document.createElement("div");
    a.className = "avatar";
    a.style.background = colorFor(name);
    a.textContent = name.charAt(0).toUpperCase();
    return a;
}

function nearBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 120;
}

// ---------- channels ----------
function buildChannelList() {
    CHANNELS.forEach((c) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "channel";
        btn.dataset.ch = c.id;
        const hash = document.createElement("span");
        hash.className = "hash";
        hash.textContent = "#";
        const name = document.createElement("span");
        name.className = "cname";
        name.textContent = c.id;
        const dot = document.createElement("span");
        dot.className = "udot";
        dot.hidden = true;
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.hidden = true;
        btn.append(hash, name, dot, badge);
        btn.addEventListener("click", () => switchChannel(c.id));
        li.append(btn);
        channelList.append(li);
    });
}

function updateBadges() {
    channelList.querySelectorAll(".channel").forEach((btn) => {
        const ch = btn.dataset.ch;
        const box = store[ch];
        const active = ch === current;
        btn.classList.toggle("active", active);
        btn.classList.toggle("unread", !active && box.unread > 0);
        btn.querySelector(".udot").hidden = active || box.unread === 0 || box.mentions > 0;
        const badge = btn.querySelector(".badge");
        badge.hidden = active || box.mentions === 0;
        badge.textContent = box.mentions;
        if (active) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
        let label = "#" + ch;
        if (!active && box.unread) label += ", " + box.unread + " unread";
        if (!active && box.mentions) label += ", " + box.mentions + " mentions";
        btn.setAttribute("aria-label", label);
    });
}

function channelInfo(id) {
    return CHANNELS.find((c) => c.id === id);
}

function renderChannelHeader() {
    const info = channelInfo(current);
    chanNameEl.textContent = current;
    chanTopicEl.textContent = info.topic;
    msgInput.placeholder = "Message #" + current;
    welcomeTitle.textContent = "Welcome to #" + current;
    welcomeText.textContent = "This is the start of the #" + current + " channel. " + info.topic + ".";
}

function renderChannel() {
    unloadAllPics();   // the old channel's pictures leave the screen: free them
    const items = store[current].items;
    const nodes = [];
    items.forEach((item, i) => buildNodes(item, items[i - 1]).forEach((n) => nodes.push(n)));
    logEl.replaceChildren(welcomeEl, ...nodes, typingEl);
    logEl.scrollTop = logEl.scrollHeight;
}

function switchChannel(ch) {
    if (ch === current) { closeDrawers(); return; }
    stopTyping();                       // we were typing in the old channel
    drafts[current] = msgInput.value;   // keep what was typed, per channel
    current = ch;
    msgInput.value = drafts[ch] || "";
    store[ch].unread = 0;
    store[ch].mentions = 0;
    updateBadges();
    renderChannelHeader();
    renderChannel();
    renderTyping();
    closeDrawers();
    if (!msgInput.disabled) msgInput.focus();
}

// ---------- messages ----------
const dayKey = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
};

function dayLabel(ts) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (dayKey(ts) === dayKey(Date.now())) return "Today";
    if (dayKey(ts) === dayKey(yesterday.getTime())) return "Yesterday";
    return new Date(ts).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

const timeLabel = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function mentionsMe(text) {
    const safe = myName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^\\w])@" + safe + "(?![\\w])", "i").test(text);
}

// Writes text into an element, turning @names of people who are online into tags.
function appendText(el, text) {
    const names = Array.from(peers.values()).map((p) => p.name).sort((a, b) => b.length - a.length);
    let buf = "";
    let i = 0;
    while (i < text.length) {
        if (text[i] === "@" && (i === 0 || !/\w/.test(text[i - 1]))) {
            const hit = names.find((n) =>
                text.substr(i + 1, n.length).toLowerCase() === n.toLowerCase() &&
                !/\w/.test(text.charAt(i + 1 + n.length)));
            if (hit) {
                if (buf) { el.append(buf); buf = ""; }
                const tag = document.createElement("span");
                tag.className = "mention-tag" + (same(hit, myName) ? " me" : "");
                tag.textContent = text.substr(i, hit.length + 1);
                el.append(tag);
                i += hit.length + 1;
                continue;
            }
        }
        buf += text[i];
        i++;
    }
    if (buf) el.append(buf);
}

function makeDivider(ts) {
    const d = document.createElement("div");
    d.className = "divider";
    const label = document.createElement("span");
    label.textContent = dayLabel(ts);
    d.append(label);
    return d;
}

function makeSystem(item) {
    const s = document.createElement("div");
    s.className = "sys";
    s.textContent = item.text;
    return s;
}

function makeMessage(item, grouped) {
    const mine = item.id === myId;
    const row = document.createElement("div");
    row.className = "msg " + (grouped ? "cont" : "head") + (mine ? " mine" : "") + (item.mention ? " mention" : "");

    const gutter = document.createElement("div");
    gutter.className = "gutter";
    const content = document.createElement("div");
    content.className = "content";

    if (grouped) {
        const t = document.createElement("time");
        t.textContent = timeLabel(item.ts);
        gutter.append(t);
    } else {
        gutter.append(makeAvatar(item.name));
        const meta = document.createElement("div");
        meta.className = "meta";
        const who = document.createElement("b");
        who.textContent = item.name;
        const time = document.createElement("time");
        time.textContent = timeLabel(item.ts);
        meta.append(who, time);
        content.append(meta);
    }

    if (item.kind === "img") {
        content.append(makeImageBubble(item));
    } else {
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        appendText(bubble, item.text);
        content.append(bubble);
    }

    row.append(gutter, content);
    return row;
}

// One item can become several nodes: an optional date divider, then the item.
function buildNodes(item, prev) {
    const nodes = [];
    const newDay = !prev || dayKey(prev.ts) !== dayKey(item.ts);
    if (newDay) nodes.push(makeDivider(item.ts));
    if (item.kind === "sys") {
        nodes.push(makeSystem(item));
        return nodes;
    }
    const grouped = !newDay && prev.kind !== "sys" && prev.id === item.id && item.ts - prev.ts < GROUP_MS;
    nodes.push(makeMessage(item, grouped));
    return nodes;
}

function addItem(ch, item) {
    const box = store[ch];
    const prev = box.items[box.items.length - 1];
    box.items.push(item);
    if (box.items.length > 500) {
        box.items.splice(0, 100).forEach(forgetItem);
        if (ch === current) renderChannel();
        return;
    }
    if (ch !== current) return;
    const stick = item.id === myId || nearBottom();
    buildNodes(item, prev).forEach((n) => logEl.insertBefore(n, typingEl)); // typing bubble stays last
    if (stick) logEl.scrollTop = logEl.scrollHeight;
}

function addSystem(text, ch) {
    addItem(ch || "general", { kind: "sys", text, ts: Date.now() });
}

function receiveMessage(ch, id, name, text) {
    const mine = id === myId;
    const mention = !mine && mentionsMe(text);
    addItem(ch, { kind: "msg", id, name, text, ts: Date.now(), mention });
    if (!mine) noteUnread(ch, mention);
}

function noteUnread(ch, mention) {
    if (ch === current) return;
    store[ch].unread++;
    if (mention) store[ch].mentions++;
    updateBadges();
}

// ---------- pictures ----------
// A picture travels as one header packet and many small data packets:
//   IMGH|id|name|channel|picId|packets|mime|bytes|width|height
//   IMGC|id|name|picId|index|base64data
const images = new Map();    // picId -> item (every picture we know about)
const incoming = new Map();  // picId -> { item, parts, got, total, timer }  (still arriving)
const liveUrls = new Map();  // picId -> object URL of a picture currently on screen
let storedBytes = 0;
let hiddenTimer = null;

const picObserver = window.IntersectionObserver
    ? new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) showPic(e.target); else hidePic(e.target); });
    }, { root: logEl, rootMargin: "250px 0px" })
    : null;

const newPicId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

function fitSize(w, h) {
    const scale = Math.min(1, 360 / w, 380 / h);
    return Math.round(w * scale);
}

function makeImageBubble(item) {
    const bubble = document.createElement("div");
    bubble.className = "bubble pic-bubble";

    const fig = document.createElement("figure");
    fig.className = "pic";
    fig.dataset.img = item.imgId;
    fig.style.width = fitSize(item.w, item.h) + "px";
    fig.style.aspectRatio = item.w + " / " + item.h;

    const img = document.createElement("img");
    img.alt = "Picture from " + item.name;
    img.decoding = "async";
    img.draggable = false;

    // The animated placeholder shown while a picture arrives or (re)loads.
    const load = document.createElement("div");
    load.className = "pic-load";
    const chip = document.createElement("span");
    chip.className = "pic-chip";
    const dots = document.createElement("span");
    dots.className = "pic-dots";
    dots.innerHTML = "<i></i><i></i><i></i>";
    const label = document.createElement("span");
    label.className = "pic-label";
    chip.append(dots, label);
    const bar = document.createElement("span");
    bar.className = "pic-bar";
    bar.innerHTML = "<b></b>";
    load.append(chip, bar);

    fig.append(img, load);
    fig.addEventListener("click", () => { if (fig.dataset.state === "ready") openLightbox(item); });
    bubble.append(fig);

    applyPicState(fig, item);
    return bubble;
}

function setPicState(fig, state, text) {
    fig.dataset.state = state;
    fig.querySelector(".pic-label").textContent = text;
}

// Make a picture's box match its item (called when it is built and whenever the item changes).
function applyPicState(fig, item) {
    const pct = Math.round(item.progress * 100);
    if (item.status === "receiving" || item.status === "sending") {
        setPicState(fig, "transfer", (item.status === "sending" ? "Sending " : "Receiving ") + pct + "%");
        fig.querySelector(".pic-bar b").style.width = pct + "%";
    } else if (item.status === "failed") {
        dropSrc(fig);
        setPicState(fig, "failed", item.failText || "Picture didn't arrive");
    } else if (item.status === "expired") {
        dropSrc(fig);
        setPicState(fig, "expired", "Removed to save memory");
    } else if (item.status === "ready") {
        if (!fig.querySelector("img").getAttribute("src")) setPicState(fig, "unloaded", "Loading...");
        requestLoad(fig);
    }
}

function updatePicUI(item) {
    const fig = logEl.querySelector('[data-img="' + item.imgId + '"]');
    if (fig) applyPicState(fig, item);
}

// Ask for a picture to be loaded if it is on screen. The observer answers
// straight away, then again whenever the picture scrolls in or out.
function requestLoad(fig) {
    if (picObserver) {
        picObserver.unobserve(fig);
        picObserver.observe(fig);
    } else {
        showPic(fig);
    }
}

function releaseUrl(picId) {
    const url = liveUrls.get(picId);
    if (url) { URL.revokeObjectURL(url); liveUrls.delete(picId); }
}

function dropSrc(fig) {
    const img = fig.querySelector("img");
    if (img.getAttribute("src")) {
        img.onload = null;
        img.onerror = null;
        img.removeAttribute("src");
    }
    releaseUrl(fig.dataset.img);
}

// On screen (or about to be): put the picture in memory and show it.
function showPic(fig) {
    const item = images.get(fig.dataset.img);
    if (!item || item.status !== "ready" || !item.blob) return;
    const img = fig.querySelector("img");
    if (img.getAttribute("src")) return;   // already loaded or loading

    const url = URL.createObjectURL(item.blob);
    liveUrls.set(item.imgId, url);
    setPicState(fig, "loading", "Loading...");
    const started = Date.now();
    img.onload = () => {
        const wait = Math.max(0, MIN_LOADING_MS - (Date.now() - started));
        setTimeout(() => {
            if (img.getAttribute("src") === url) setPicState(fig, "ready", "");
        }, wait);
    };
    img.onerror = () => setPicState(fig, "failed", "Couldn't show this picture");
    img.src = url;
}

// Off screen: let go of the decoded picture. It reloads when you scroll back to it.
function hidePic(fig) {
    const img = fig.querySelector("img");
    if (!img.getAttribute("src")) return;
    dropSrc(fig);
    setPicState(fig, "unloaded", "Loading...");
}

function unloadAllPics() {
    if (picObserver) picObserver.disconnect();
    liveUrls.forEach((url) => URL.revokeObjectURL(url));
    liveUrls.clear();
}

// Forget the oldest pictures if memory use grows too large.
function trimPictures() {
    if (storedBytes <= MAX_STORE_BYTES) return;
    const old = Array.from(images.values()).filter((it) => it.blob).sort((a, b) => a.ts - b.ts);
    for (const it of old) {
        if (storedBytes <= MAX_STORE_BYTES) break;
        storedBytes -= it.blob.size;
        it.blob = null;
        it.status = "expired";
        releaseUrl(it.imgId);
        updatePicUI(it);
    }
}

// A message scrolled out of the 500-message history.
function forgetItem(item) {
    if (!item.imgId) return;
    const tr = incoming.get(item.imgId);
    if (tr) { clearTimeout(tr.timer); incoming.delete(item.imgId); }
    if (item.blob) storedBytes -= item.blob.size;
    images.delete(item.imgId);
    releaseUrl(item.imgId);
}

// Free every picture while the tab is hidden; bring the visible ones back afterwards.
document.addEventListener("visibilitychange", () => {
    clearTimeout(hiddenTimer);
    if (document.hidden) {
        hiddenTimer = setTimeout(() => logEl.querySelectorAll(".pic").forEach(hidePic), HIDDEN_UNLOAD_MS);
    } else {
        logEl.querySelectorAll(".pic").forEach(requestLoad);
    }
});

// ----- receiving -----
function onImageHeader(m) {
    if (m.id === myId) return;                       // our own picture comes back to us: ignore
    const hd = splitPayload(m.payload);
    const f = hd.text.split("|");                    // picId, packets, mime, bytes, width, height
    const picId = f[0], total = +f[1], mime = f[2], size = +f[3], w = +f[4], h = +f[5];
    const sane = picId && images.has(picId) === false &&
        total >= 1 && total <= 2000 && size > 0 && size <= MAX_RECV_BYTES &&
        IMAGE_TYPES.indexOf(mime) >= 0 && w >= 1 && h >= 1 && w <= 8192 && h <= 8192;
    if (!sane) return;

    const item = { kind: "img", id: m.id, name: m.name, ts: Date.now(), imgId: picId, mime, size, w, h,
                   status: "receiving", progress: 0, blob: null };
    images.set(picId, item);
    incoming.set(picId, { item, parts: new Array(total), got: 0, total,
                          timer: setTimeout(() => failPicture(picId, "Picture didn't arrive"), TRANSFER_TIMEOUT_MS) });
    clearTyper(m.id);
    addPeer(m.id, m.name);
    addItem(hd.ch, item);
    noteUnread(hd.ch, false);
}

function onImageChunk(m) {
    if (m.id === myId) return;
    const k1 = m.payload.indexOf("|");
    const k2 = m.payload.indexOf("|", k1 + 1);
    if (k1 < 1 || k2 < 0) return;
    const tr = incoming.get(m.payload.slice(0, k1));
    if (!tr) return;                                 // we joined mid-transfer: skip it
    const index = +m.payload.slice(k1 + 1, k2);
    if (!(index >= 0 && index < tr.total) || tr.parts[index] !== undefined) return;

    tr.parts[index] = m.payload.slice(k2 + 1);
    tr.got++;
    tr.item.progress = tr.got / tr.total;
    clearTimeout(tr.timer);
    tr.timer = setTimeout(() => failPicture(tr.item.imgId, "Picture didn't arrive"), TRANSFER_TIMEOUT_MS);

    if (tr.got < tr.total) {
        updatePicUI(tr.item);
    } else {
        clearTimeout(tr.timer);
        incoming.delete(tr.item.imgId);
        try {
            const blob = base64ToBlob(tr.parts.join(""), tr.item.mime);
            if (blob.size !== tr.item.size) throw new Error("size mismatch");
            completePicture(tr.item, blob);
        } catch (err) {
            failPicture(tr.item.imgId, "Picture arrived damaged");
        }
    }
}

function completePicture(item, blob) {
    item.blob = blob;
    item.progress = 1;
    item.status = "ready";
    storedBytes += blob.size;
    updatePicUI(item);
    trimPictures();
}

function failPicture(picId, text) {
    const tr = incoming.get(picId);
    if (tr) { clearTimeout(tr.timer); incoming.delete(picId); }
    const item = images.get(picId);
    if (!item) return;
    item.status = "failed";
    item.failText = text;
    updatePicUI(item);
}

function base64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Couldn't read that picture."));
    r.readAsDataURL(blob);
});

// ----- sending -----
async function decodeImage(file) {
    if (window.createImageBitmap) {
        try { return await createImageBitmap(file); } catch (err) { /* fall back to <img> */ }
    }
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that picture.")); };
        img.src = url;
    });
}

// Shrink and compress so a picture is a few dozen packets, not thousands.
async function prepareImage(file) {
    if (!/^image\//.test(file.type)) throw new Error("That file isn't a picture.");
    const src = await decodeImage(file);
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    if (!sw || !sh) throw new Error("Couldn't read that picture.");

    // Small GIFs are sent as they are, so they keep moving.
    if (file.type === "image/gif" && file.size <= MAX_IMG_BYTES) {
        return { blob: file, w: sw, h: sh, mime: "image/gif" };
    }

    let scale = Math.min(1, MAX_DIM / Math.max(sw, sh));
    let quality = 0.82;
    for (let attempt = 0; attempt < 8; attempt++) {
        const w = Math.max(1, Math.round(sw * scale));
        const h = Math.max(1, Math.round(sh * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(src, 0, 0, w, h);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob) throw new Error("Couldn't process that picture.");
        if (blob.size <= MAX_IMG_BYTES) return { blob, w, h, mime: "image/jpeg" };
        if (quality > 0.5) quality -= 0.12; else scale *= 0.8;
    }
    throw new Error("That picture is too detailed to send. Try a smaller one.");
}

const sendQueue = [];
let sendingNow = false;

function queueImage(file) {
    if (!joined || state !== "online") { addSystem("Connect first, then send your picture.", current); return; }
    sendQueue.push({ file, ch: current });
    if (!sendingNow) runSendQueue();
}

async function runSendQueue() {
    sendingNow = true;
    while (sendQueue.length) {
        const job = sendQueue.shift();
        try {
            await sendImage(job.file, job.ch);
        } catch (err) {
            addSystem("Couldn't send that picture: " + err.message, job.ch);
        }
    }
    sendingNow = false;
}

async function sendImage(file, ch) {
    const pic = await prepareImage(file);
    const data = await blobToBase64(pic.blob);
    const parts = [];
    for (let i = 0; i < data.length; i += CHUNK_CHARS) parts.push(data.slice(i, i + CHUNK_CHARS));

    const picId = newPicId();
    const item = { kind: "img", id: myId, name: myName, ts: Date.now(), imgId: picId, mime: pic.mime,
                   size: pic.blob.size, w: pic.w, h: pic.h, status: "sending", progress: 0, blob: pic.blob };
    images.set(picId, item);
    storedBytes += pic.blob.size;
    addItem(ch, item);

    try {
        const header = [ch, picId, parts.length, pic.mime, pic.blob.size, pic.w, pic.h].join("|");
        if (!sendPacket("IMGH", myId, myName, header)) throw new Error("Not connected.");
        for (let i = 0; i < parts.length; i++) {
            while (socket && socket.bufferedAmount > 256 * 1024) await sleep(20);
            if (!sendPacket("IMGC", myId, myName, picId + "|" + i + "|" + parts[i])) throw new Error("Connection lost while sending.");
            item.progress = (i + 1) / parts.length;
            if (i % 3 === 2) { updatePicUI(item); await sleep(CHUNK_PACKET_DELAY_MS); }
        }
    } catch (err) {
        item.status = "failed";
        item.failText = "Couldn't send";
        updatePicUI(item);
        throw err;
    }
    item.progress = 1;
    item.status = "ready";
    updatePicUI(item);
    trimPictures();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----- viewing -----
let lbUrl = null;
function openLightbox(item) {
    if (!item.blob) return;
    closeLightbox();
    lbUrl = URL.createObjectURL(item.blob);
    lbImg.src = lbUrl;
    lightbox.hidden = false;
}
function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    lbImg.removeAttribute("src");
    if (lbUrl) { URL.revokeObjectURL(lbUrl); lbUrl = null; }
}
lightbox.addEventListener("click", closeLightbox);

// ----- ways to pick a picture -----
attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
    Array.from(fileInput.files).forEach(queueImage);
    fileInput.value = "";
});

msgInput.addEventListener("paste", (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => /^image\//.test(f.type));
    if (files.length) {
        e.preventDefault();
        files.forEach(queueImage);
    }
});

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf("Files") >= 0;
const mainEl = chatScreen.querySelector(".main");
mainEl.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; dropHint.hidden = false; } });
mainEl.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
mainEl.addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropHint.hidden = true; } });
mainEl.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    Array.from(e.dataTransfer.files).filter((f) => /^image\//.test(f.type)).forEach(queueImage);
});

// ---------- members ----------
function insertMention(name) {
    const v = msgInput.value;
    msgInput.value = v + (v && !/\s$/.test(v) ? " " : "") + "@" + name + " ";
    msgInput.focus();
    msgInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderUsers() {
    const list = Array.from(peers.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name));
    countEl.textContent = list.length;
    usersEl.replaceChildren();
    list.forEach(([id, p]) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "member";
        const label = document.createElement("span");
        label.textContent = p.name;
        btn.append(makeAvatar(p.name), label);
        if (id === myId) {
            const tag = document.createElement("span");
            tag.className = "you";
            tag.textContent = "you";
            btn.append(tag);
            btn.title = "That's you";
        } else {
            btn.title = "Click to mention " + p.name;
            btn.addEventListener("click", () => { insertMention(p.name); closeDrawers(); });
        }
        li.append(btn);
        usersEl.appendChild(li);
    });
}

// ---------- drawers (small screens) ----------
function closeDrawers() {
    channelsEl.classList.remove("open");
    panel.classList.remove("open");
    scrim.classList.remove("show");
    chanBtn.setAttribute("aria-expanded", "false");
    whoBtn.setAttribute("aria-expanded", "false");
}

function toggleDrawer(el, btn) {
    const open = !el.classList.contains("open");
    closeDrawers();
    if (open) {
        el.classList.add("open");
        scrim.classList.add("show");
        btn.setAttribute("aria-expanded", "true");
    }
}

chanBtn.addEventListener("click", () => toggleDrawer(channelsEl, chanBtn));
whoBtn.addEventListener("click", () => toggleDrawer(panel, whoBtn));
scrim.addEventListener("click", closeDrawers);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDrawers(); closeLightbox(); }
    // Alt + Up/Down jumps between channels
    if (joined && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const i = CHANNELS.findIndex((c) => c.id === current);
        const next = CHANNELS[(i + (e.key === "ArrowDown" ? 1 : CHANNELS.length - 1)) % CHANNELS.length];
        switchChannel(next.id);
    }
});

// ---------- events ----------
$("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (claim) return;
    const name = nameInput.value.trim();
    if (name.length < 2) return showJoinError("Username needs at least 2 characters.");
    if (name.indexOf("|") >= 0) return showJoinError("Usernames can't contain |");
    if (state !== "online") return showJoinError("Not connected yet. Wait for the green dot.");
    startClaim(name);
});

function showJoinError(text) {
    joinError.textContent = text;
    joinError.hidden = false;
    nameInput.focus();
}

$("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text || !joined) return;
    if (sendPacket("MSG", myId, myName, current + "|" + text)) {
        msgInput.value = "";
        drafts[current] = "";
        cancelTyping();
    }
    msgInput.focus();
});

buildChannelList();
renderChannelHeader();
updateBadges();
renderChannel();
connect();