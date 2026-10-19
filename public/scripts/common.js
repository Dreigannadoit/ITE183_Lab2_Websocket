// ==========================================
// Property of (c) Drei Abmab || R.A BAMBA
// ==========================================

// BISCORD shared code. Loaded first by BOTH login.html and chat.html.
// Holds the connection address, the "who is logged in" helpers and the console.

const $ = (id) => document.getElementById(id);

const wsUrl = location.protocol.indexOf("http") === 0
    ? (location.protocol === "https:" ? "wss://" : "ws://") + location.host
    : "ws://localhost:8000";

// ---------- who is logged in ----------
// The login page and the chat page are separate pages, so the login page leaves a note
// in this browser tab (sessionStorage): the tab id the server knows you by, and your name.
// The chat page reads it and asks the server to confirm it (RESUME packet).
// Closing the tab forgets it, so every tab has to log in on its own.
const SESSION_KEY = "chatterbox.session";
const FLASH_KEY = "chatterbox.flash";   // a one-time message shown on the login page

function newId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

// A private secret for this login. It is sent to the server together with the password and is
// never shown to other people, so the server can tell that edit / delete requests really come
// from this login (a tab id alone is visible to everyone in the chat).
function newSecret() {
    const bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => (b < 16 ? "0" : "") + b.toString(16)).join("");
}

function loadSession() {
    try {
        const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
        if (s && s.id && s.name) return s;
    } catch (err) { /* storage unavailable */ }
    return null;
}

function saveSession(id, name, secret) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, name, secret })); } catch (err) { }
}

function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (err) { }
}

function setFlash(text) {
    try { sessionStorage.setItem(FLASH_KEY, text); } catch (err) { }
}

function takeFlash() {
    try {
        const text = sessionStorage.getItem(FLASH_KEY) || "";
        sessionStorage.removeItem(FLASH_KEY);
        return text;
    } catch (err) { return ""; }
}

// Every packet looks like  TYPE|id|name|payload  (the payload keeps any extra "|")
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

// ---------- console (shows what travels over the socket) ----------
const consoleEl = $("console"), consoleBody = $("consoleBody"), consoleToggle = $("consoleToggle");
// Packets too chatty (or too private, like passwords) to list in the console.
const QUIET_TYPES = ["TYPING", "IMGC", "IMGGET", "PICH", "PICC", "SIGNUP", "LOGIN", "RESUME", "LOGOUT", "SAVE", "HISTORY", "HIST", "HISTEND", "USERS", "USER", "USEREND", "AUTHOK", "AUTHERR", "SAVEERR", "EDIT", "EDITERR", "DELETE", "DELETEERR",
    "PROFGET", "PROF", "PROFNONE", "PROFF", "PROFDONE", "PROFOK", "PROFERR", "PROFCHG", "PFUH", "PFUC", "PFUDEL", "PFGET", "PFIH", "PFIC", "PFIERR"];
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

// On the chat page keep the console just above the message box,
// unless the user has moved it somewhere else. On the login page it sits in the corner.
function placeConsole() {
    if (userPlaced) { clampConsole(); return; }
    const bar = $("chatForm");
    const chatScreenEl = $("chatScreen");
    const chatOn = !!(bar && chatScreenEl && chatScreenEl.classList.contains("active"));
    const lift = chatOn ? bar.offsetHeight : 0;
    // On wide screens, start just right of the channel column.
    const wide = window.matchMedia ? window.matchMedia("(min-width: 901px)").matches : false;
    const chans = $("channels");
    const side = chatOn && wide && chans ? chans.offsetWidth : 0;
    consoleEl.style.left = (side + 14) + "px";
    consoleEl.style.bottom = (lift + 14) + "px";
}
window.addEventListener("resize", placeConsole);
if (window.ResizeObserver && $("chatForm")) new ResizeObserver(placeConsole).observe($("chatForm"));

consoleToggle.addEventListener("click", () => {
    if (suppressClick) return; // this click was the end of a drag
    const open = consoleEl.classList.toggle("open");
    consoleBody.inert = !open;
    consoleToggle.setAttribute("aria-expanded", open);
    if (open) consoleBody.scrollTop = consoleBody.scrollHeight;
    if (userPlaced) clampConsole(); // opening makes it bigger: keep it on screen
});

// The console grows and shrinks with an animation, so check again once it has stopped moving.
consoleEl.addEventListener("transitionend", (e) => {
    if (e.target !== consoleEl && e.target !== consoleBody) return;
    if (consoleEl.classList.contains("open")) consoleBody.scrollTop = consoleBody.scrollHeight;
    if (userPlaced) clampConsole();
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

placeConsole();
