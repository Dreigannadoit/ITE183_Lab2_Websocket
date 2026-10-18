// BISCORD chat page. Loaded by chat.html, after common.js.
// Logging in / signing up happens on the login page (login.html + login.js).
// This page only asks the server "is this tab still logged in?" (RESUME) and, if not,
// sends you back to the login page.

// ---------- connection ----------
// Chat history is handled by the server (app.bzg) over this same WebSocket.

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

// joinScreen is the small "getting your chat ready" card; chatScreen is the chat itself.
const joinScreen = $("joinScreen"), chatScreen = $("chatScreen");
const msgInput = $("msgInput"), sendBtn = $("sendBtn");
const logEl = $("log"), usersEl = $("users"), countEl = $("count");
const totalEl = $("total");
const panel = $("panel"), whoBtn = $("whoBtn"), chanBtn = $("chanBtn");
const channelsEl = $("channels"), channelList = $("channelList"), scrim = $("scrim");
const chanNameEl = $("chanName"), chanTopicEl = $("chanTopic");
const welcomeEl = $("welcome"), welcomeTitle = $("welcomeTitle"), welcomeText = $("welcomeText");
const typingEl = $("typing"), typingText = $("typingText");
const attachBtn = $("attachBtn"), fileInput = $("fileInput"), dropHint = $("dropHint");
const lightbox = $("lightbox"), lbImg = $("lbImg");

// ---------- packet types ----------
const PACKET_TYPES = ["CLAIM", "TAKEN", "HELLO", "HERE", "BYE", "MSG", "TYPING", "IMGH", "IMGC"];
const HISTORY_WAIT_MS = 5000;      // how long we wait for saved chat before joining anyway
const AUTH_WAIT_MS = 5000;         // how long we wait for the server to confirm the login
let warnedUnknown = false;

// The login page gave this tab its id and name. Without them we were never logged in here.
const stored = loadSession();
if (!stored) location.replace("/");
const myId = stored ? stored.id : "";
const mySecret = stored && stored.secret ? stored.secret : "";   // proves to the server that edit / delete come from this login

let socket = null;
let retryTimer = null;
let retryDelay = 1000;
let state = "connecting";
let joined = false;
let myName = "";
let claim = null;            // { id, name, timer } while we wait to see if a name is free
let authTimer = null;        // gives up if the server never confirms the login
let resuming = false;        // true while we wait for the server to confirm the login
let leaving = false;         // true once we are on our way back to the login page
let historyBuf = null;       // saved messages arriving from the server: channel id -> [msg]
let historyDone = null;      // called when the last saved message has arrived
let historyTimer = null;
const peers = new Map();     // id -> { name, seen }   (people online right now)
const registered = new Map(); // lower-case name -> name   (every account, from the server)
const askedAbout = new Set(); // names we already refreshed the account list for
let usersBuf = null;         // account names arriving from the server (null = no request running)
let usersTimer = null;
let usersAgain = false;      // a new name showed up while a request was running
let usersLoaded = false;
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
                const msg = splitMsg(m.payload);
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

// MSG payload:  channel|messageId|text   ->  { ch, mid, text }
const MID_RE = /^[a-z0-9]{1,24}$/;
function splitMsg(payload) {
    const a = splitPayload(payload);
    const k = a.text.indexOf("|");
    if (k > 0 && MID_RE.test(a.text.slice(0, k))) {
        return { ch: a.ch, mid: a.text.slice(0, k), text: a.text.slice(k + 1) };
    }
    return { ch: a.ch, mid: "", text: a.text };
}

// "a|b|c|rest of it"  ->  ["a", "b", "c", "rest of it"]   (n fields, then whatever is left)
function takeFields(s, n) {
    const out = [];
    let rest = s;
    for (let i = 0; i < n; i++) {
        const k = rest.indexOf("|");
        if (k < 0) { out.push(rest); rest = ""; } else { out.push(rest.slice(0, k)); rest = rest.slice(k + 1); }
    }
    out.push(rest);
    return out;
}

// Every message gets an id when it is sent. Everybody uses it to find that message again
// when the author edits or deletes it.
const newMsgId = () => "m" + newSecret().slice(0, 14);

// ---------- connection popup ----------
// One small popup in the bottom right corner instead of a line in the chat for every retry.
// "lost": spinner + "Connection lost. Trying to reconnect..." stays up while we keep retrying.
// "back": tick + "Reconnected", then it slides away on its own.
const connToast = $("connToast"), connText = $("connText");
const TOAST_BACK_MS = 1800;   // how long "Reconnected" stays before it leaves
const TOAST_EXIT_MS = 320;    // a little longer than the exit animation
let toastTimer = null, toastExitTimer = null;

// "<name> joined the chat" popups. They stack in the same corner, just above the connection popup.
const joinToasts = $("joinToasts");
const JOIN_TOAST_MS = 4000;    // how long a join popup stays
const MAX_JOIN_TOASTS = 4;     // more than this at once: the oldest goes

// Sit just above the message box so it never covers the Send button.
function placeToast() {
    connToast.style.bottom = (($("chatForm").offsetHeight || 0) + 14) + "px";
    placeJoinToasts();
}

function placeJoinToasts() {
    const lift = connToast.hidden ? 0 : connToast.offsetHeight + 12;
    joinToasts.style.bottom = (($("chatForm").offsetHeight || 0) + 14 + lift) + "px";
}

function showJoinToast(name) {
    placeJoinToasts();
    while (joinToasts.children.length >= MAX_JOIN_TOASTS) joinToasts.firstElementChild.remove();
    const t = document.createElement("div");
    t.className = "join-toast";
    const text = document.createElement("span");
    const who = document.createElement("b");
    who.textContent = name;
    text.append(who, " joined the chat");
    t.append(makeAvatar(name), text);
    joinToasts.append(t);
    setTimeout(() => dismissJoinToast(t), JOIN_TOAST_MS);
}

function dismissJoinToast(t) {
    if (!t.isConnected || t.classList.contains("leaving")) return;
    t.classList.add("leaving");
    setTimeout(() => t.remove(), TOAST_EXIT_MS);
}
window.addEventListener("resize", placeToast);
if (window.ResizeObserver) new ResizeObserver(placeToast).observe($("chatForm"));

function showConnToast(kind, text) {
    clearTimeout(toastTimer);
    clearTimeout(toastExitTimer);
    connToast.dataset.state = kind;
    connText.textContent = text;
    placeToast();
    if (connToast.hidden || connToast.classList.contains("leaving")) {
        // (re)start the entrance animation. Already showing: just change the text and icon.
        connToast.classList.remove("leaving", "entering");
        connToast.hidden = false;
        void connToast.offsetWidth;
        connToast.classList.add("entering");
        placeJoinToasts();
    }
}

function hideConnToast() {
    clearTimeout(toastTimer);
    if (connToast.hidden) return;
    connToast.classList.remove("entering");
    connToast.classList.add("leaving");
    clearTimeout(toastExitTimer);
    toastExitTimer = setTimeout(() => {
        connToast.hidden = true;
        connToast.classList.remove("leaving");
        placeJoinToasts();
    }, TOAST_EXIT_MS);
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
            requestUsers();
            sendPacket("HELLO", myId, myName, "re");
            if (!connToast.hidden) {
                showConnToast("back", "Reconnected");
                toastTimer = setTimeout(hideConnToast, TOAST_BACK_MS);
            }
        } else if (!resuming) {
            resumeSession();
        }
    };

    socket.onmessage = (event) => {
        let data = String(event.data);

        // The original lab server wraps every message as "User <n> says: <text>".
        // Unwrap it so the chat still works if that server is running.
        const wrapped = /^User \d+ says: ([\s\S]*)$/.exec(data);
        if (wrapped) data = wrapped[1];

        const m = parse(data);
        // Profile packets are only ever sent by the server to one tab. A copy that came wrapped as
        // "User <n> says: ..." was relayed from another client, so it is a fake and is ignored.
        if (wrapped && /^(PROF|PF)/.test(m.type)) return;
        if (handleServerReply(m)) return;
        if (QUIET_TYPES.indexOf(m.type) < 0) {
            if (m.type === "MSG") {
                const msg = splitMsg(m.payload);
                logLine("Server", m.name + " says in #" + msg.ch + ": " + msg.text);
            } else if (m.type === "IMGH") {
                const hd = splitPayload(m.payload);
                logLine("Server", m.name + " sent a picture in #" + hd.ch + " (" + Math.round(hd.text.split("|")[3] / 1024) + " KB)");
            } else {
                logLine("Server", data);
            }
        }

        // The server announces an edit or delete to everybody. A copy that came wrapped as
        // "User <n> says: ..." was relayed from a client, so it is a fake and is ignored.
        if (m.type === "EDITED" || m.type === "DELETED") {
            if (!wrapped) applyRemote(m);
            return;
        }
        if (m.type === "PROFCHG") {
            if (!wrapped && joined) onProfileChanged(m.name);
            return;
        }

        if (PACKET_TYPES.indexOf(m.type) < 0) {
            if (!warnedUnknown) {
                warnedUnknown = true;
                logLine("System", "Ignored a message that isn't a BISCORD packet. If the chat stays empty, make sure the server is running the new app.bzg.");
            }
            return;
        }
        handle(data);
    };

    socket.onclose = () => {
        if (leaving) return;
        if (claim) { clearTimeout(claim.timer); claim = null; }
        if (!joined) { clearTimeout(authTimer); resuming = false; }   // ask again once we reconnect
        if (historyDone) finishHistory();
        cancelTyping();
        clearAllTypers();
        setStatus("offline");
        logLine("System", "Connection closed. Retrying in " + (retryDelay / 1000) + "s ...");
        if (joined) showConnToast("lost", "Connection lost. Trying to reconnect...");
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
    };

    socket.onerror = () => logLine("System", "Connection error.");
}

// ---------- protocol ----------
function handle(data) {
    const m = parse(data);

    // Username checks work before we have joined.
    // (a claim carries its own one-off id, so a second tab of the same login can't hide behind it)
    if (m.type === "CLAIM") {
        if (claim && m.id === claim.id) return;     // our own claim, echoed back
        const owner = joined && same(m.name, myName);
        // If two people claim the same name at once, the lower id wins.
        const tie = claim && same(m.name, claim.name) && claim.id < m.id;
        if (owner || tie) sendPacket("TAKEN", m.id, m.name, "");
        return;
    }
    if (m.type === "TAKEN") {
        if (claim && m.id === claim.id && same(m.name, claim.name)) failClaim();
        return;
    }

    if (!joined) return;

    if (m.type === "HELLO") {
        addPeer(m.id, m.name);
        if (m.payload !== "re" && m.id !== myId) showJoinToast(m.name);
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
        const msg = splitMsg(m.payload);
        clearTyper(m.id);
        addPeer(m.id, m.name);
        receiveMessage(msg.ch, m.id, m.name, msg.text, msg.mid);
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
    // Someone we have no account for yet (they just signed up): refresh the account list, once per name.
    const key = name.toLowerCase();
    if (usersLoaded && !registered.has(key) && !askedAbout.has(key)) {
        askedAbout.add(key);
        requestUsers();
    }
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

// Leaves this page for the login page. `text` is shown there once.
function leaveToLogin(text) {
    leaving = true;
    clearTimeout(authTimer);
    clearSession();
    if (text) setFlash(text);
    location.replace("/");
}

// The server confirmed who we are. Make sure nobody is already online under this name.
function startClaim(name) {
    claim = { id: newId(), name, timer: setTimeout(finishClaim, CLAIM_MS) };
    sendPacket("CLAIM", claim.id, name, "");
}

function failClaim() {
    clearTimeout(claim.timer);
    claim = null;
    leaveToLogin("That account is already online in another tab or device.");
}

// Ask the server whether the login this tab holds is still good (answered with AUTHOK or AUTHERR).
function resumeSession() {
    resuming = true;
    clearTimeout(authTimer);
    authTimer = setTimeout(() => leaveToLogin("The server didn't answer. Is app.bzg running?"), AUTH_WAIT_MS);
    sendPacket("RESUME", myId, "", "");
}

async function finishClaim() {
    if (!claim) return;
    myName = claim.name;
    // Bring back the saved chat first, so it is already on screen when the chat opens.
    await loadHistory();
    if (!claim) return;
    claim = null;
    joined = true;
    logLine("System", "Username accepted. Joined as " + myName + ".");
    $("meName").textContent = myName;
    $("meAvatar").style.background = colorFor(myName);
    $("meAvatar").textContent = myName.charAt(0).toUpperCase();
    resetPeers();
    showScreen("chat");
    setStatus(state);
    renderChannel();
    requestUsers();
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
    // Online people plus everyone with an account, so an @name keeps its tag after a save
    // even when that person happens to be offline or the roster hasn't refreshed.
    const known = new Map();
    registered.forEach((n, key) => known.set(key, n));
    peers.forEach((p) => known.set(p.name.toLowerCase(), p.name));
    const names = Array.from(known.values()).sort((a, b) => b.length - a.length);
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

    let bubble;
    if (item.kind === "img") {
        bubble = makeImageBubble(item);
    } else {
        bubble = document.createElement("div");
        bubble.className = "bubble";
        fillBubble(bubble, item);
    }

    if (item.mid) row.dataset.mid = item.mid;
    if (item.mid && same(item.name, myName)) {
        // Your own message: it gets Edit / Delete buttons. (Other people's messages never do.)
        // The buttons are only a convenience; the server checks again who wrote the message.
        if (item.kind === "img" && item.status === "sending") row.classList.add("busy");
        const wrap = document.createElement("div");
        wrap.className = "bwrap";
        wrap.append(bubble, makeActions(item));
        content.append(wrap);
    } else {
        content.append(bubble);
    }

    row.append(gutter, content);
    syncEditedNote(row, item);
    return row;
}

// The text of a message bubble (with a small "(edited)" note after an edit).
function fillBubble(bubble, item) {
    bubble.replaceChildren();
    appendText(bubble, item.text);
}

// The small "(edited)" note sits under the bubble, not inside it.
function syncEditedNote(row, item) {
    const content = row && row.querySelector(".content");
    if (!content) return;
    let note = content.querySelector(".edited-note");
    if (item.edited && item.kind === "msg") {
        if (!note) {
            note = document.createElement("small");
            note.className = "edited-note";
            note.textContent = "(edited)";
            content.append(note);
        }
    } else if (note) {
        note.remove();
    }
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

function receiveMessage(ch, id, name, text, mid) {
    const mine = id === myId;
    const mention = !mine && mentionsMe(text);
    addItem(ch, { kind: "msg", id, name, text, ts: Date.now(), mention, mid: mid || "", edited: false });
    if (!mine) noteUnread(ch, mention);
}

function noteUnread(ch, mention) {
    if (ch === current) return;
    store[ch].unread++;
    if (mention) store[ch].mentions++;
    updateBadges();
}

// ---------- edit and delete your own messages ----------
// Only the author gets the buttons, and the server only accepts EDIT / DELETE from the author
// (it checks the secret from login and who wrote the message), so this is more than cosmetics.
//   EDIT|id|name|secret|messageId|newText      DELETE|id|name|secret|messageId
// The server answers everybody with  EDITED||user|channel|messageId|text  or  DELETED||user|channel|messageId
// and answers a refusal to the sender only (EDITERR / DELETEERR with the reason).
const PENCIL_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';

function actionButton(label, html, extraClass, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "act-btn" + (extraClass ? " " + extraClass : "");
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = html;
    b.addEventListener("click", onClick);
    return b;
}

function makeActions(item) {
    const bar = document.createElement("div");
    bar.className = "msg-actions";

    function show(confirming) {
        bar.classList.toggle("confirming", confirming);
        bar.replaceChildren();
        if (confirming) {
            const q = document.createElement("span");
            q.className = "act-ask";
            q.textContent = item.kind === "img" ? "Delete picture?" : "Delete message?";
            const yes = actionButton("Yes, delete", "Delete", "text danger", () => sendDelete(item));
            const no = actionButton("Keep it", "Keep", "text", () => show(false));
            bar.append(q, yes, no);
            no.focus();
        } else {
            if (item.kind === "msg") bar.append(actionButton("Edit message", PENCIL_SVG, "", () => startEdit(item, bar)));
            bar.append(actionButton(item.kind === "img" ? "Delete picture" : "Delete message", TRASH_SVG, "danger", () => show(true)));
        }
    }
    show(false);
    return bar;
}

function findRow(mid) {
    return MID_RE.test(mid) ? logEl.querySelector('.msg[data-mid="' + mid + '"]') : null;
}

// Swaps the message bubble for a small box with the text, Save and Cancel.
function startEdit(item, bar) {
    const wrap = bar.parentElement;
    const bubble = wrap.querySelector(".bubble");
    if (!bubble || wrap.querySelector(".edit-form")) return;

    const form = document.createElement("form");
    form.className = "edit-form";
    const input = document.createElement("input");
    input.className = "field edit-input";
    input.type = "text";
    input.maxLength = 1000;
    input.value = item.text;
    input.setAttribute("aria-label", "Edit your message");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "btn small blue";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn small";
    cancel.textContent = "Cancel";
    const hint = document.createElement("small");
    hint.className = "edit-hint";
    hint.textContent = "Enter to save, Esc to cancel";
    form.append(input, save, cancel, hint);

    const close = () => { form.remove(); bubble.hidden = false; bar.hidden = false; };
    cancel.addEventListener("click", close);
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text || text === item.text) { close(); return; }      // nothing changed (an empty message isn't allowed)
        if (sendEdit(item, text)) close();                          // the new text shows up when the server confirms
    });

    bubble.hidden = true;
    bar.hidden = true;
    wrap.append(form);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

function sendEdit(item, text) {
    if (!sendPacket("EDIT", myId, myName, mySecret + "|" + item.mid + "|" + text)) {
        addSystem("Couldn't edit your message: not connected.", current);
        return false;
    }
    return true;
}

function sendDelete(item) {
    if (!sendPacket("DELETE", myId, myName, mySecret + "|" + item.mid)) {
        addSystem("Couldn't delete your message: not connected.", current);
    }
}

// The server tells everybody (this tab included) that a message was edited or deleted.
function applyRemote(m) {
    if (!joined) return;
    const a = splitPayload(m.payload);               // channel | rest
    if (m.type === "EDITED") {
        const k = a.text.indexOf("|");
        if (k > 0) applyEdited(a.ch, a.text.slice(0, k), m.name, a.text.slice(k + 1));
    } else {
        applyDeleted(a.ch, a.text, m.name);
    }
}

// Finds a message we hold by its id. It must also be written by `name`: a notice about
// somebody else's message is ignored.
function findOwned(ch, mid, name) {
    if (!MID_RE.test(mid) || !store[ch]) return -1;
    const at = store[ch].items.findIndex((it) => it.mid === mid && it.kind !== "sys");
    if (at < 0 || !same(store[ch].items[at].name, name)) return -1;
    return at;
}

function applyEdited(ch, mid, name, text) {
    const at = findOwned(ch, mid, name);
    if (at < 0) return;
    const item = store[ch].items[at];
    if (item.kind !== "msg") return;
    item.text = text;
    item.edited = true;
    // An edit can add or remove an @mention of me, so the highlight has to follow the new text.
    if (item.id !== myId) {
        const now = mentionsMe(text);
        if (now && !item.mention && ch !== current) { store[ch].mentions++; updateBadges(); }
        item.mention = now;
    }
    const row = ch === current ? findRow(mid) : null;
    if (row) row.classList.toggle("mention", !!item.mention);
    const bubble = row && row.querySelector(".bubble");
    if (bubble) fillBubble(bubble, item);
    syncEditedNote(row, item);
}

function applyDeleted(ch, mid, name) {
    const at = findOwned(ch, mid, name);
    if (at < 0) return;
    const gone = store[ch].items.splice(at, 1)[0];
    forgetItem(gone);
    if (ch !== current) return;
    const stick = nearBottom();
    const top = logEl.scrollTop;
    renderChannel();                                  // closes the gap and fixes the grouping and date dividers
    if (!stick) logEl.scrollTop = top;
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
    } else if (item.status === "saved") {
        dropSrc(fig);
        setPicState(fig, "unloaded", "Loading...");
        requestLoad(fig);
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
    if (item && item.status === "saved") { fetchSaved(item); return; }
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
        it.status = it.saved ? "saved" : "expired";
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
                   mid: picId, status: "receiving", progress: 0, blob: null };
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
    acceptChunk(m.payload);
}

// payload is  picId|index|base64data  (live from another person, or PICC from the server)
function acceptChunk(payload) {
    const k1 = payload.indexOf("|");
    const k2 = payload.indexOf("|", k1 + 1);
    if (k1 < 1 || k2 < 0) return;
    const tr = incoming.get(payload.slice(0, k1));
    if (!tr) return;                                 // we joined mid-transfer: skip it
    const index = +payload.slice(k1 + 1, k2);
    if (!(index >= 0 && index < tr.total) || tr.parts[index] !== undefined) return;

    tr.parts[index] = payload.slice(k2 + 1);
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
                   mid: picId, size: pic.blob.size, w: pic.w, h: pic.h, status: "sending", progress: 0, blob: pic.blob };
    images.set(picId, item);
    storedBytes += pic.blob.size;
    addItem(ch, item);

    try {
        const header = [ch, picId, parts.length, pic.mime, pic.blob.size, pic.w, pic.h, item.ts].join("|");
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
    const sentRow = findRow(item.mid);
    if (sentRow) sentRow.classList.remove("busy");   // sent: its Delete button can show now
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

// Ask the server for every registered account (answered with USER ..., USEREND).
function requestUsers() {
    if (usersBuf) { usersAgain = true; return; }     // one request at a time
    usersBuf = [];
    clearTimeout(usersTimer);
    usersTimer = setTimeout(finishUsers, HISTORY_WAIT_MS);
    if (!sendPacket("USERS", myId, myName, "")) { usersBuf = null; clearTimeout(usersTimer); }
}

function finishUsers() {
    clearTimeout(usersTimer);
    if (usersBuf) {
        registered.clear();
        usersBuf.forEach((n) => registered.set(n.toLowerCase(), n));
        usersLoaded = true;
    }
    usersBuf = null;
    renderUsers();
    if (usersAgain) { usersAgain = false; requestUsers(); }
}

// Everyone with an account. People who are online right now (green) come first, then the rest (grey).
function renderUsers() {
    const rows = new Map();   // lower-case name -> { name, id }   (id = the tab that is online, or null)
    registered.forEach((name, key) => rows.set(key, { name, id: null }));
    peers.forEach((p, id) => {
        const key = p.name.toLowerCase();
        const row = rows.get(key);
        if (row) { row.id = id; row.name = p.name; } else rows.set(key, { name: p.name, id });
    });
    const list = Array.from(rows.values()).sort((a, b) =>
        (a.id === null) - (b.id === null) || a.name.localeCompare(b.name));
    countEl.textContent = list.filter((r) => r.id !== null).length;
    totalEl.textContent = list.length;
    usersEl.replaceChildren();
    list.forEach((r) => {
        const active = r.id !== null;
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "member " + (active ? "active" : "inactive");
        btn.setAttribute("aria-label", r.name + (active ? ", online" : ", offline"));
        const label = document.createElement("span");
        label.textContent = r.name;
        btn.append(makeAvatar(r.name), label);
        if (same(r.name, myName)) {
            const tag = document.createElement("span");
            tag.className = "you";
            tag.textContent = "you";
            btn.append(tag);
            btn.title = "View your profile";
        } else {
            btn.title = "View " + r.name + "'s profile" + (active ? "" : " (offline)");
        }
        btn.setAttribute("aria-haspopup", "dialog");
        btn.addEventListener("click", () => { closeDrawers(); openProfile(r.name); });
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
    if (e.key === "Escape") { closeDrawers(); closeLightbox(); closeProfile(); }
    // Alt + Up/Down jumps between channels
    if (joined && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const i = CHANNELS.findIndex((c) => c.id === current);
        const next = CHANNELS[(i + (e.key === "ArrowDown" ? 1 : CHANNELS.length - 1)) % CHANNELS.length];
        switchChannel(next.id);
    }
});

// ---------- events ----------
// Messages the server sends to this tab only (not part of the live chat).
// Returns true when it handled the packet.
function handleServerReply(m) {
    if (m.id !== myId) return false;
    if (m.type === "AUTHOK") {
        clearTimeout(authTimer);
        resuming = false;
        if (!claim && !joined) startClaim(m.name);
        return true;
    }
    if (m.type === "AUTHERR") {
        leaveToLogin(m.name);
        return true;
    }
    if (m.type === "HIST") {
        // name = who wrote it, payload = channel|timestamp|messageId|edited|text
        const a = splitPayload(m.payload);
        const f = takeFields(a.text, 3);               // timestamp, messageId, edited, text
        if (historyBuf && historyBuf[a.ch] && a.text.indexOf("|") >= 0) {
            historyBuf[a.ch].push({ user: m.name, ts: Number(f[0]) || Date.now(), mid: f[1], edited: f[2] === "1", text: f[3] });
        }
        return true;
    }
    if (m.type === "HISTEND") {
        finishHistory();
        return true;
    }
    if (m.type === "USER") {
        // name = a registered username
        if (usersBuf && m.name) usersBuf.push(m.name);
        return true;
    }
    if (m.type === "USEREND") {
        finishUsers();
        return true;
    }
    if (m.type === "PICH") {
        // name = picId, payload = packets|mime|bytes   (a saved picture is on its way)
        const f = m.payload.split("|");
        const item = images.get(m.name);
        const total = +f[0];
        if (item && total >= 1 && total <= 2000) {
            const old = incoming.get(m.name);
            if (old) clearTimeout(old.timer);
            incoming.set(m.name, { item, parts: new Array(total), got: 0, total,
                                   timer: setTimeout(() => failPicture(m.name, "Picture didn't arrive"), TRANSFER_TIMEOUT_MS) });
        }
        return true;
    }
    if (m.type === "PICC") {
        acceptChunk(m.name + "|" + m.payload);       // name = picId, payload = index|data
        return true;
    }
    if (m.type === "PICERR") {
        failPicture(m.name, "Picture is no longer saved");
        return true;
    }
    if (m.type === "PROF") { onProfile(m); return true; }
    if (m.type === "PROFNONE") { onProfileMissing(m.name); return true; }
    if (m.type === "PROFOK") { onProfileSaved(); return true; }
    if (m.type === "PROFERR") { onProfileError(m.name); return true; }
    if (m.type === "PFIH") { onProfileImageHeader(m); return true; }
    if (m.type === "PFIC") { onProfileImageChunk(m); return true; }
    if (m.type === "PFIERR") { onProfileImageMissing({ name: m.name, payload: m.payload }); return true; }
    if (m.type === "EDITERR" || m.type === "DELETEERR") {
        // name = the reason
        const what = m.type === "EDITERR" ? "edit" : "delete";
        logLine("System", "Couldn't " + what + " the message: " + m.name);
        addSystem("Couldn't " + what + " that message: " + m.name, current);
        return true;
    }
    if (m.type === "SAVEERR") {
        logLine("System", "Message not saved: " + m.name);
        addSystem("Your login expired, so new messages aren't being saved. Log out and back in.", current);
        return true;
    }
    return false;
}

// Log out: tell everyone we left, tell the server to forget this login, go back to the login page.
$("logoutBtn").addEventListener("click", () => {
    leaving = true;
    if (joined) sendPacket("BYE", myId, myName, "");
    sendPacket("LOGOUT", myId, myName, "");
    joined = false;
    clearSession();
    location.href = "/";
});

// ---------- saved chat ----------
// Past messages come from the server (app.bzg) as HIST packets, ending with HISTEND.
// Items get the id "h:<name>" so grouping works; messages from you count as yours.
function loadHistory() {
    return new Promise((resolve) => {
        historyBuf = {};
        CHANNELS.forEach((c) => { historyBuf[c.id] = []; });
        historyDone = resolve;
        clearTimeout(historyTimer);
        historyTimer = setTimeout(() => {
            logLine("System", "Couldn't load saved chat: the server didn't answer.");
            finishHistory();
        }, HISTORY_WAIT_MS);
        if (!sendPacket("HISTORY", myId, myName, "")) finishHistory();
    });
}

function finishHistory() {
    clearTimeout(historyTimer);
    if (historyBuf) {
        logLine("System", "Saved chat received: " + CHANNELS.map((c) => "#" + c.id + " " + (historyBuf[c.id] || []).length).join(", "));
        CHANNELS.forEach((c) => {
            store[c.id].items = (historyBuf[c.id] || []).map((m) => {
                const who = same(m.user, myName) ? myId : "h:" + m.user.toLowerCase();
                return savedPicture(m, who) || {
                    kind: "msg", id: who, name: m.user, text: m.text, ts: m.ts, mention: false,
                    mid: m.mid, edited: !!m.edited
                };
            });
        });
    }
    historyBuf = null;
    const done = historyDone;
    historyDone = null;
    if (done) done();
}

// A saved picture is stored in the chat log as  [img]picId,mime,bytes,width,height
// Build a picture item that fetches its data from the server when it scrolls into view.
function savedPicture(m, who) {
    if (m.text.slice(0, 5) !== "[img]") return null;
    const f = m.text.slice(5).split(",");
    const picId = f[0], mime = f[1], size = +f[2], w = +f[3], h = +f[4];
    if (!picId || IMAGE_TYPES.indexOf(mime) < 0 || !(size > 0) || !(w >= 1) || !(h >= 1)) return null;
    const item = { kind: "img", id: who, name: m.user, ts: m.ts, imgId: picId, mime, size, w, h,
                   mid: m.mid || picId, status: "saved", saved: true, progress: 0, blob: null };
    images.set(picId, item);
    return item;
}

// Ask the server for a saved picture (answered with PICH, PICC ..., see handleServerReply).
function fetchSaved(item) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    item.status = "receiving";
    item.progress = 0;
    updatePicUI(item);
    sendPacket("IMGGET", myId, myName, item.imgId);
    // if the server never answers, show the usual "didn't arrive" state
    const tr = { item, parts: [], got: 0, total: 0,
                 timer: setTimeout(() => failPicture(item.imgId, "Picture didn't arrive"), TRANSFER_TIMEOUT_MS) };
    incoming.set(item.imgId, tr);
}

// Tell the server to keep this message (it also reaches everyone live through MSG).
function saveMessage(ch, text, mid) {
    sendPacket("SAVE", myId, ch, Date.now() + "|" + mid + "|" + text);
}

$("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text || !joined) return;
    const mid = newMsgId();
    if (sendPacket("MSG", myId, myName, current + "|" + mid + "|" + text)) {
        saveMessage(current, text, mid);
        msgInput.value = "";
        drafts[current] = "";
        cancelTyping();
    }
    msgInput.focus();
});

// ---------- profiles ----------
// A profile card shows a person's picture, backdrop, thought bubble, bio and links.
// It opens from your own user card (bottom left) or from a member in the right-hand panel.
// Packets (see app.bzg; all answers go to this tab only):
//   PROFGET|id||username              -> PROF|id|username|since|avatarVer|backdropVer|color|thought|links|bio
//   PFGET|id||username|kind           -> PFIH + PFIC ... (a picture, kind = avatar or backdrop) or PFIERR
//   PROFF|id||secret|field|value      change one of YOUR fields (thought, bio, links, color)
//   PROFDONE|id||secret               all fields sent -> PROFOK, and everybody gets PROFCHG||username
//   PFUH / PFUC / PFUDEL              upload / remove YOUR picture or backdrop
// Text fields travel URL-encoded so they can never contain the "|" separator.
const PROF = { thought: 80, bio: 240, linkLabel: 20, linkUrl: 120, links: 3 };
const PROF_ENC_MAX = { thought: 300, bio: 900, links: 1400 };     // same limits as the server
const AVATAR_PX = 160;
const BACKDROP_W = 600, BACKDROP_H = 200;
const AVATAR_MAX_BYTES = 40 * 1024, BACKDROP_MAX_BYTES = 70 * 1024;
const PROF_WAIT_MS = 5000;
const PROFILE_COLORS = ["", "FF6FA5", "35D07F", "5CCBFF", "FF8A2B", "8B5CF6", "FFD23F", "2D6BFF"];   // "" = automatic

const profileModal = $("profileModal"), profileCard = $("profileCard");
const profiles = new Map();   // lower-case name -> profile (see blankProfile)
const profileImgBuf = new Map(); // "name|kind" -> picture pieces still arriving
let profOpen = "";            // lower-case name of the card on screen ("" = closed)
let profEditing = false;
let profDraft = null;
let profTimer = null;
let profOpener = null;        // what had focus before the card opened
let profAck = null;           // { resolve, reject } while a save waits for the server

function blankProfile(name) {
    return { name, loaded: false, failed: false, since: 0, color: "", thought: "", bio: "", links: [],
             avatarVer: 0, backdropVer: 0, avatarUrl: "", backdropUrl: "", avatarShown: -1, backdropShown: -1 };
}

function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (err) { return ""; } };
const hexOk = (c) => /^[0-9a-fA-F]{6}$/.test(c);
const accentOf = (p) => (hexOk(p.color) ? "#" + p.color : colorFor(p.name));

// Links are stored as JSON. Anything that isn't a plain http(s) address is dropped.
function parseLinks(json) {
    let list = [];
    try { list = JSON.parse(json); } catch (err) { return []; }
    if (!Array.isArray(list)) return [];
    return list.slice(0, PROF.links).map((x) => ({
        l: String((x && x.l) || "").slice(0, PROF.linkLabel),
        u: String((x && x.u) || "").slice(0, PROF.linkUrl)
    })).filter((x) => /^https?:\/\/[^\s]+$/i.test(x.u));
}

function normalizeUrl(u) {
    u = u.trim();
    if (!u) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
    return u;
}

function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (err) { return u; }
}

// ----- opening and closing -----
function openProfile(name) {
    const key = name.toLowerCase();
    profOpener = document.activeElement;
    profOpen = key;
    profEditing = false;
    profDraft = null;
    if (!profiles.has(key)) profiles.set(key, blankProfile(name));
    const p = profiles.get(key);
    p.failed = false;
    profileModal.hidden = false;
    renderProfile();
    refreshProfile(key);
    const first = profileCard.querySelector("button");
    if (first) first.focus();
}

function refreshProfile(key) {
    const p = profiles.get(key);
    if (!p) return;
    clearTimeout(profTimer);
    profTimer = setTimeout(() => {
        if (!p.loaded) { p.failed = true; if (profOpen === key && !profEditing) renderProfile(); }
    }, PROF_WAIT_MS);
    if (!sendPacket("PROFGET", myId, "", p.name)) { p.failed = true; renderProfile(); }
}

function closeProfile() {
    if (profileModal.hidden) return;
    discardDraftPreviews();
    profileModal.hidden = true;
    profOpen = "";
    profEditing = false;
    profDraft = null;
    clearTimeout(profTimer);
    profileCard.replaceChildren();
    if (profOpener && profOpener.focus) { try { profOpener.focus(); } catch (err) { } }
    profOpener = null;
}

profileModal.addEventListener("mousedown", (e) => { if (e.target === profileModal) closeProfile(); });

function dropProfile(key) {
    const p = profiles.get(key);
    if (!p) return;
    [p.avatarUrl, p.backdropUrl].forEach((u) => { if (u) URL.revokeObjectURL(u); });
    profiles.delete(key);
}

// ----- messages from the server -----
function onProfile(m) {
    // name = username, payload = since|avatarVer|backdropVer|color|thought|links|bio
    const key = m.name.toLowerCase();
    const p = profiles.get(key);
    if (!p) return;
    const f = m.payload.split("|");
    p.name = m.name;
    p.since = Number(f[0]) || 0;
    p.avatarVer = Number(f[1]) || 0;
    p.backdropVer = Number(f[2]) || 0;
    p.color = hexOk(f[3] || "") ? f[3] : "";
    p.thought = safeDecode(f[4] || "").slice(0, PROF.thought);
    p.links = parseLinks(safeDecode(f[5] || ""));
    p.bio = safeDecode(f[6] || "").slice(0, PROF.bio);
    p.loaded = true;
    p.failed = false;
    clearTimeout(profTimer);
    ["avatar", "backdrop"].forEach((kind) => {
        const ver = p[kind + "Ver"];
        if (ver === 0) {
            if (p[kind + "Url"]) URL.revokeObjectURL(p[kind + "Url"]);
            p[kind + "Url"] = "";
            p[kind + "Shown"] = 0;
        } else if (p[kind + "Shown"] !== ver) {
            p[kind + "Shown"] = ver;          // asked for: the picture shows up when it arrives
            sendPacket("PFGET", myId, "", p.name + "|" + kind);
        }
    });
    if (profOpen === key && !profEditing) renderProfile();
}

function onProfileMissing(name) {
    const p = profiles.get(name.toLowerCase());
    if (!p) return;
    p.failed = true;
    clearTimeout(profTimer);
    if (profOpen === name.toLowerCase() && !profEditing) renderProfile();
}

function onProfileChanged(name) {
    const key = name.toLowerCase();
    if (profOpen === key) {
        if (!profEditing) refreshProfile(key);   // while you are editing, the save refreshes it afterwards
    } else {
        dropProfile(key);
    }
}

// PFIH: name = username, payload = kind|packets|mime
function onProfileImageHeader(m) {
    const f = m.payload.split("|");
    const total = +f[1];
    if (!profiles.has(m.name.toLowerCase()) || !(total >= 1 && total <= 99)) return;
    const key = m.name.toLowerCase() + "|" + f[0];
    const old = profileImgBuf.get(key);
    if (old) clearTimeout(old.timer);
    profileImgBuf.set(key, { parts: new Array(total), got: 0, total, mime: f[2],
        timer: setTimeout(() => profileImgBuf.delete(key), TRANSFER_TIMEOUT_MS) });
}

// PFIC: name = username, payload = kind|index|data
function onProfileImageChunk(m) {
    const k1 = m.payload.indexOf("|");
    const k2 = m.payload.indexOf("|", k1 + 1);
    if (k1 < 0 || k2 < 0) return;
    const kind = m.payload.slice(0, k1);
    const index = +m.payload.slice(k1 + 1, k2);
    const key = m.name.toLowerCase() + "|" + kind;
    const buf = profileImgBuf.get(key);
    if (!buf || !(index >= 0 && index < buf.total) || buf.parts[index] !== undefined) return;
    buf.parts[index] = m.payload.slice(k2 + 1);
    buf.got++;
    if (buf.got < buf.total) return;
    clearTimeout(buf.timer);
    profileImgBuf.delete(key);
    const p = profiles.get(m.name.toLowerCase());
    if (!p || (kind !== "avatar" && kind !== "backdrop")) return;
    try {
        const url = URL.createObjectURL(base64ToBlob(buf.parts.join(""), IMAGE_TYPES.indexOf(buf.mime) >= 0 ? buf.mime : "image/jpeg"));
        if (p[kind + "Url"]) URL.revokeObjectURL(p[kind + "Url"]);
        p[kind + "Url"] = url;
    } catch (err) { return; }
    if (profOpen === m.name.toLowerCase() && !profEditing) renderProfile();
}

function onProfileImageMissing(m) {
    // name = username, payload = kind: nothing to show, keep the letter / colour
    const p = profiles.get(m.name.toLowerCase());
    if (p && (m.payload === "avatar" || m.payload === "backdrop")) p[m.payload + "Shown"] = -1;
}

// ----- drawing the card -----
function isOnline(name) {
    return Array.from(peers.values()).some((x) => same(x.name, name));
}

function paintBanner(banner, p, previewUrl) {
    const url = previewUrl !== undefined ? previewUrl : p.backdropUrl;
    banner.style.backgroundColor = accentOf(p);
    if (url) {
        banner.classList.add("has-img");
        banner.style.backgroundImage = 'url("' + url + '")';
    } else {
        banner.classList.remove("has-img");
        banner.style.backgroundImage = "";
    }
}

function paintAvatar(av, p, previewUrl) {
    const url = previewUrl !== undefined ? previewUrl : p.avatarUrl;
    av.style.backgroundColor = colorFor(p.name);
    if (url) {
        av.classList.add("has-img");
        av.style.backgroundImage = 'url("' + url + '")';
        av.textContent = "";
    } else {
        av.classList.remove("has-img");
        av.style.backgroundImage = "";
        av.textContent = p.name.charAt(0).toUpperCase();
    }
}

function renderProfile() {
    const p = profiles.get(profOpen);
    if (!p) return;
    profileCard.replaceChildren();
    profileCard.setAttribute("aria-label", p.name + "'s profile");
    if (profEditing && profDraft) renderProfileEdit(p);
    else renderProfileView(p);
}

function makeCloseButton() {
    const b = mk("button", "btn small prof-close", "Close");
    b.type = "button";
    b.addEventListener("click", closeProfile);
    return b;
}

function renderProfileView(p) {
    const mine = same(p.name, myName);
    const banner = mk("div", "prof-banner");
    paintBanner(banner, p);
    banner.append(makeCloseButton());

    const body = mk("div", "prof-body");
    const top = mk("div", "prof-top");
    const av = mk("div", "prof-avatar");
    paintAvatar(av, p);
    top.append(av);
    if (p.thought) {
        top.append(mk("div", "prof-thought", p.thought));
    } else if (mine && p.loaded) {
        top.append(mk("div", "prof-thought empty", "Add a thought bubble…"));
    }
    body.append(top, mk("h2", "prof-name", p.name));
    profileCard.setAttribute("aria-label", p.name + "'s profile");

    const status = mk("div", "prof-status");
    const on = isOnline(p.name);
    const pill = mk("span", "pill");
    pill.dataset.state = on ? "online" : "offline";
    pill.append(mk("span", "dot"), mk("span", "txt", on ? "Online" : "Offline"));
    status.append(pill);
    if (p.since) {
        status.append(mk("span", "prof-since", "Member since " +
            new Date(p.since * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })));
    }
    body.append(status);

    if (!p.loaded) {
        body.append(mk("p", "prof-note", p.failed ? "Couldn't load this profile." : "Loading…"));
        if (p.failed) {
            const retry = mk("button", "btn small", "Try again");
            retry.type = "button";
            retry.addEventListener("click", () => { p.failed = false; renderProfile(); refreshProfile(profOpen); });
            const row = mk("div", "prof-actions");
            row.append(retry);
            body.append(row);
        }
        profileCard.append(banner, body);
        return;
    }

    const about = mk("div", "prof-sec");
    about.append(mk("h3", "", "About"));
    about.append(p.bio ? mk("p", "prof-bio", p.bio)
                      : mk("p", "prof-muted", mine ? "You haven't written a bio yet." : "No bio yet."));
    body.append(about);

    if (p.links.length) {
        const sec = mk("div", "prof-sec");
        sec.append(mk("h3", "", "Links"));
        const ul = mk("ul", "prof-links");
        p.links.forEach((x) => {
            const li = mk("li");
            const a = mk("a");
            a.href = x.u;
            a.target = "_blank";
            a.rel = "noopener noreferrer nofollow";
            a.append(document.createTextNode(x.l || hostOf(x.u)));
            if (x.l) a.append(mk("small", "", hostOf(x.u)));
            li.append(a);
            ul.append(li);
        });
        sec.append(ul);
        body.append(sec);
    } else if (mine) {
        const sec = mk("div", "prof-sec");
        sec.append(mk("h3", "", "Links"), mk("p", "prof-muted", "No links yet."));
        body.append(sec);
    }

    const actions = mk("div", "prof-actions");
    if (mine) {
        const edit = mk("button", "btn blue small", "Edit profile");
        edit.type = "button";
        edit.addEventListener("click", startProfileEdit);
        actions.append(edit);
    } else {
        const mention = mk("button", "btn blue small", "Mention @" + p.name);
        mention.type = "button";
        mention.addEventListener("click", () => { insertMention(p.name); closeProfile(); closeDrawers(); });
        actions.append(mention);
    }
    body.append(actions);
    profileCard.append(banner, body);
}

// ----- editing your own card -----
function startProfileEdit() {
    const p = profiles.get(profOpen);
    if (!p || !same(p.name, myName)) return;
    const rows = p.links.map((x) => ({ l: x.l, u: x.u }));
    while (rows.length < PROF.links) rows.push({ l: "", u: "" });
    profDraft = { thought: p.thought, bio: p.bio, links: rows, color: p.color,
                  avatar: null, avatarGone: false, avatarPreview: "",
                  backdrop: null, backdropGone: false, backdropPreview: "",
                  saving: false, error: "" };
    profEditing = true;
    renderProfile();
    const f = profileCard.querySelector("input[type=text]");
    if (f) f.focus();
}

function discardDraftPreviews() {
    if (!profDraft) return;
    if (profDraft.avatarPreview) URL.revokeObjectURL(profDraft.avatarPreview);
    if (profDraft.backdropPreview) URL.revokeObjectURL(profDraft.backdropPreview);
}

function cancelProfileEdit() {
    discardDraftPreviews();
    profEditing = false;
    profDraft = null;
    renderProfile();
    refreshProfile(profOpen);
}

// Crop to the middle of the picture so it fills w x h, then squeeze it under maxBytes.
async function cropPicture(file, w, h, maxBytes) {
    if (!/^image\//.test(file.type)) throw new Error("That file isn't a picture.");
    const src = await decodeImage(file);
    const sw = src.naturalWidth || src.width;
    const sh = src.naturalHeight || src.height;
    if (!sw || !sh) throw new Error("Couldn't read that picture.");
    const scale = Math.max(w / sw, h / sh);
    const cw = w / scale, ch = h / scale;
    const sx = (sw - cw) / 2, sy = (sh - ch) / 2;
    let quality = 0.86, ow = w, oh = h;
    for (let attempt = 0; attempt < 8; attempt++) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(ow);
        canvas.height = Math.round(oh);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(src, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob) throw new Error("Couldn't process that picture.");
        if (blob.size <= maxBytes) return blob;
        if (quality > 0.5) quality -= 0.12; else { ow *= 0.85; oh *= 0.85; }
    }
    throw new Error("That picture is too detailed. Try a smaller one.");
}

async function chooseProfilePicture(kind, file) {
    const d = profDraft;
    if (!d || !file) return;
    d.error = "";
    try {
        const blob = kind === "avatar"
            ? await cropPicture(file, AVATAR_PX, AVATAR_PX, AVATAR_MAX_BYTES)
            : await cropPicture(file, BACKDROP_W, BACKDROP_H, BACKDROP_MAX_BYTES);
        if (d !== profDraft) return;                    // the card was closed meanwhile
        if (d[kind + "Preview"]) URL.revokeObjectURL(d[kind + "Preview"]);
        d[kind] = blob;
        d[kind + "Gone"] = false;
        d[kind + "Preview"] = URL.createObjectURL(blob);
    } catch (err) {
        d.error = err.message;
    }
    if (profEditing && d === profDraft) renderProfile();
}

function removeProfilePicture(kind) {
    const d = profDraft;
    if (d[kind + "Preview"]) URL.revokeObjectURL(d[kind + "Preview"]);
    d[kind] = null;
    d[kind + "Preview"] = "";
    d[kind + "Gone"] = true;
    renderProfile();
}

function filePicker(kind) {
    const input = mk("input", "prof-file");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
        const f = input.files && input.files[0];
        input.value = "";
        chooseProfilePicture(kind, f);
    });
    return input;
}

function toolButton(label, onClick, disabled) {
    const b = mk("button", "btn small", label);
    b.type = "button";
    b.disabled = !!disabled;
    b.addEventListener("click", onClick);
    return b;
}

function renderProfileEdit(p) {
    const d = profDraft;
    const busy = d.saving;
    const view = Object.assign({}, p, { color: d.color });

    // what the card will show once saved: the new picture, or none if it is being removed
    const bgUrl = d.backdropGone ? "" : (d.backdropPreview || p.backdropUrl);
    const avUrl = d.avatarGone ? "" : (d.avatarPreview || p.avatarUrl);

    const banner = mk("div", "prof-banner");
    paintBanner(banner, view, bgUrl);
    banner.append(makeCloseButton());
    const bpick = filePicker("backdrop");
    const tools = mk("div", "prof-banner-tools");
    tools.append(toolButton("Change backdrop", () => bpick.click(), busy),
                 toolButton("Remove", () => removeProfilePicture("backdrop"), busy || !bgUrl));
    banner.append(tools, bpick);

    const body = mk("form", "prof-body prof-form");
    body.autocomplete = "off";
    body.addEventListener("submit", (e) => { e.preventDefault(); saveProfile(); });

    const top = mk("div", "prof-top");
    const av = mk("div", "prof-avatar");
    paintAvatar(av, view, avUrl);
    top.append(av);
    const thought = mk("input", "field");
    thought.type = "text";
    thought.maxLength = PROF.thought;
    thought.value = d.thought;
    thought.placeholder = "Thought bubble: what's on your mind?";
    thought.setAttribute("aria-label", "Thought bubble");
    thought.disabled = busy;
    thought.addEventListener("input", () => { d.thought = thought.value; });
    thought.style.marginTop = "12px";
    top.append(thought);
    body.append(top);

    const apick = filePicker("avatar");
    const atools = mk("div", "prof-tools");
    atools.append(toolButton("Change picture", () => apick.click(), busy),
                  toolButton("Remove picture", () => removeProfilePicture("avatar"), busy || !avUrl), apick);
    body.append(atools);

    body.append(mk("h2", "prof-name", p.name));

    const bioLabel = mk("label", "", "About you");
    const count = mk("span", "prof-count", d.bio.length + "/" + PROF.bio);
    bioLabel.append(count);
    const bio = mk("textarea", "field");
    bio.maxLength = PROF.bio;
    bio.value = d.bio;
    bio.placeholder = "Tell people a little about yourself";
    bio.disabled = busy;
    bio.addEventListener("input", () => { d.bio = bio.value; count.textContent = bio.value.length + "/" + PROF.bio; });
    bioLabel.htmlFor = bio.id = "profBio";
    body.append(bioLabel, bio);

    body.append(mk("div", "lbl", "Links (up to " + PROF.links + ")"));
    d.links.forEach((row) => {
        const wrap = mk("div", "prof-link-row");
        const l = mk("input", "field");
        l.type = "text";
        l.maxLength = PROF.linkLabel;
        l.placeholder = "Name";
        l.value = row.l;
        l.setAttribute("aria-label", "Link name");
        l.disabled = busy;
        l.addEventListener("input", () => { row.l = l.value; });
        const u = mk("input", "field");
        u.type = "text";
        u.inputMode = "url";
        u.maxLength = PROF.linkUrl;
        u.placeholder = "https://example.com";
        u.value = row.u;
        u.setAttribute("aria-label", "Link address");
        u.disabled = busy;
        u.addEventListener("input", () => { row.u = u.value; });
        wrap.append(l, u);
        body.append(wrap);
    });

    body.append(mk("div", "lbl", "Card colour"));
    const sw = mk("div", "swatches");
    PROFILE_COLORS.forEach((c) => {
        const b = mk("button", "swatch", c ? "" : "A");
        b.type = "button";
        b.disabled = busy;
        b.style.background = c ? "#" + c : colorFor(p.name);
        b.title = c ? "#" + c : "Automatic";
        b.setAttribute("aria-label", c ? "Colour #" + c : "Automatic colour");
        b.setAttribute("aria-pressed", String(d.color === c));
        b.addEventListener("click", () => { d.color = c; renderProfile(); });
        sw.append(b);
    });
    body.append(sw);

    const err = mk("p", "prof-error", d.error);
    err.hidden = !d.error;
    err.setAttribute("role", "alert");
    body.append(err);

    const actions = mk("div", "prof-actions");
    const save = mk("button", "btn blue small", busy ? "Saving…" : "Save");
    save.type = "submit";
    save.disabled = busy;
    const cancel = toolButton("Cancel", cancelProfileEdit, busy);
    actions.append(save, cancel);
    body.append(actions);

    profileCard.append(banner, body);
}

// Sends one picture to the server in small pieces (same idea as sending a chat picture).
async function uploadProfilePicture(kind, blob) {
    const data = await blobToBase64(blob);
    const parts = [];
    for (let i = 0; i < data.length; i += CHUNK_CHARS) parts.push(data.slice(i, i + CHUNK_CHARS));
    if (parts.length < 1 || parts.length > 99) throw new Error("That picture is too big.");
    if (!sendPacket("PFUH", myId, "", mySecret + "|" + kind + "|" + blob.type + "|" + parts.length)) throw new Error("Not connected.");
    for (let i = 0; i < parts.length; i++) {
        while (socket && socket.bufferedAmount > 256 * 1024) await sleep(20);
        if (!sendPacket("PFUC", myId, "", i + "|" + parts[i])) throw new Error("Connection lost while sending.");
        if (i % 3 === 2) await sleep(CHUNK_PACKET_DELAY_MS);
    }
}

async function saveProfile() {
    const d = profDraft;
    if (!d || d.saving) return;

    const links = [];
    for (const row of d.links) {
        const u = normalizeUrl(row.u);
        if (!u) continue;
        if (!/^https?:\/\/[^\s]+$/i.test(u) || u.length > PROF.linkUrl) {
            d.error = "\"" + row.u.trim() + "\" doesn't look like a web address (it must start with http:// or https://, up to " + PROF.linkUrl + " characters).";
            renderProfile();
            return;
        }
        links.push({ l: row.l.trim(), u });
    }
    const enc = {
        thought: encodeURIComponent(d.thought.trim().slice(0, PROF.thought)),
        bio: encodeURIComponent(d.bio.trim().slice(0, PROF.bio)),
        links: links.length ? encodeURIComponent(JSON.stringify(links)) : ""
    };
    for (const k of ["thought", "bio", "links"]) {
        if (enc[k].length > PROF_ENC_MAX[k]) {
            d.error = "Your " + (k === "links" ? "links are" : k === "bio" ? "bio is" : "thought bubble is") + " too long once saved. Please shorten it.";
            renderProfile();
            return;
        }
    }

    d.saving = true;
    d.error = "";
    renderProfile();
    try {
        // the server answers PROFOK (or PROFERR) after PROFDONE
        const ack = new Promise((resolve, reject) => {
            profAck = { resolve, reject };
            setTimeout(() => reject(new Error("The server didn't answer. Please try again.")), 20000);
        });
        ack.catch(() => { });
        if (d.avatarGone) sendPacket("PFUDEL", myId, "", mySecret + "|avatar");
        else if (d.avatar) await uploadProfilePicture("avatar", d.avatar);
        if (d.backdropGone) sendPacket("PFUDEL", myId, "", mySecret + "|backdrop");
        else if (d.backdrop) await uploadProfilePicture("backdrop", d.backdrop);
        const send = (field, value) => {
            if (!sendPacket("PROFF", myId, "", mySecret + "|" + field + "|" + value)) throw new Error("Not connected.");
        };
        send("thought", enc.thought);
        send("bio", enc.bio);
        send("links", enc.links);
        send("color", d.color);
        if (!sendPacket("PROFDONE", myId, "", mySecret)) throw new Error("Not connected.");
        await ack;
    } catch (err) {
        profAck = null;
        if (d === profDraft) {
            d.saving = false;
            d.error = err.message || "Couldn't save your profile.";
            renderProfile();
        }
        return;
    }
    profAck = null;
    if (d !== profDraft) return;           // closed while saving: the change is saved anyway
    discardDraftPreviews();
    profEditing = false;
    profDraft = null;
    const p = profiles.get(profOpen);
    if (p) { p.loaded = true; }
    renderProfile();
    refreshProfile(profOpen);
}

function onProfileSaved() {
    if (profAck) profAck.resolve();
}

function onProfileError(text) {
    if (profAck) profAck.reject(new Error(text));
    else addSystem("Couldn't save your profile: " + text, current);
}

// ----- ways in -----
const userCard = document.querySelector(".usercard");
userCard.addEventListener("click", (e) => {
    if (!joined || e.target.closest("#logoutBtn")) return;
    openProfile(myName);
});
$("meOpen").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && joined) { e.preventDefault(); openProfile(myName); }
});


buildChannelList();
renderChannelHeader();
updateBadges();
renderChannel();
if (stored) connect();