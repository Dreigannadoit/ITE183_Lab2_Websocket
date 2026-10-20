// BISCORD login page. Loaded by login.html, after common.js.
// Logs in or signs up through the server (app.bzg), then hands you over to the chat page.
// The chat itself lives in chat.html + chat.js.

const AUTH_WAIT_MS = 5000;   // how long we wait for log in / sign up to be answered

const loginForm = $("loginForm"), signupForm = $("signupForm");
const loginUser = $("loginUser"), loginPass = $("loginPass"), loginBtn = $("loginBtn"), loginError = $("loginError");
const signupUser = $("signupUser"), signupPass = $("signupPass"), signupConfirm = $("signupConfirm");
const signupBtn = $("signupBtn"), signupError = $("signupError");
const tabLogin = $("tabLogin"), tabSignup = $("tabSignup"), authTagline = $("authTagline");
const authFields = [loginUser, loginPass, loginBtn, signupUser, signupPass, signupConfirm, signupBtn];

// Every visit to this page gets a fresh id. If the login works, the chat page keeps using it.
const myId = newId();
const mySecret = newSecret();   // sent with the password; the server keeps it for edit / delete

let socket = null;
let retryTimer = null;
let retryDelay = 1000;
let state = "connecting";
let authTimer = null;        // gives up if the server never answers
let authBusy = false;        // true while a log in / sign up request is running
let leaving = false;         // true once we are on our way to the chat page

function setStatus(next) {
    state = next;
    const label = { online: "Connected", connecting: "Connecting", offline: "Offline" }[state];
    const pill = $("joinStatus");
    pill.dataset.state = state;
    pill.querySelector(".txt").textContent = label;
    const online = state === "online";
    authFields.forEach((el) => { el.disabled = !online || authBusy; });
    loginBtn.textContent = authBusy ? "Please wait..." : "Log in";
    signupBtn.textContent = authBusy ? "Please wait..." : "Create account";
}

// Every packet looks like  TYPE|id|name|payload
function sendPacket(type, id, name, payload) {
    const text = type + "|" + id + "|" + name + "|" + (payload || "");
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(text);
        if (QUIET_TYPES.indexOf(type) < 0) logLine("Client", text);
        return true;
    }
    return false;
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
        (loginForm.hidden ? signupUser : loginUser).focus();
    };

    socket.onmessage = (event) => {
        let data = String(event.data);
        // The original lab server wraps every message as "User <n> says: <text>".
        const wrapped = /^User \d+ says: ([\s\S]*)$/.exec(data);
        if (wrapped) data = wrapped[1];

        // Only the server's answer to our own log in / sign up matters here.
        const m = parse(data);
        if (m.id !== myId) return;
        if (m.type === "AUTHOK") {
            clearTimeout(authTimer);
            leaving = true;
            logLine("System", "Logged in as " + m.name + ". Opening the chat...");
            saveSession(myId, m.name, mySecret);
            pageGo("/chat");
        } else if (m.type === "AUTHERR") {
            failAuth(m.name);
        }
    };

    socket.onclose = () => {
        if (leaving) return;
        if (authBusy) failAuth("Connection lost. Try again in a moment.");
        setStatus("offline");
        logLine("System", "Connection closed. Retrying in " + (retryDelay / 1000) + "s ...");
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
    };

    socket.onerror = () => logLine("System", "Connection error.");
}

// ---------- accounts ----------
function showAuthError(text) {
    const box = loginForm.hidden ? signupError : loginError;
    box.textContent = text;
    box.hidden = false;
}

function clearAuthErrors() {
    loginError.hidden = true;
    signupError.hidden = true;
}

// ---------- the log in <-> sign up switch ----------
// Switching tabs plays one choreographed animation (all with the Web Animations API, so it can be
// interrupted at any moment). In order of appearance:
//   - the yellow of the tab floods out of the spot you clicked, the old tab drains, both go jelly
//   - confetti pops out of the tab
//   - the mascot crouches, jumps, flips like a coin, lands squashed and blinks; rings ripple from its feet
//   - BISCORD does a wave: every letter hops and flashes a colour
//   - the card lifts off its shadow and settles back
//   - the tagline's words fly out and the new ones pop in
//   - the form's fields fly out one by one, the box springs to its new height, the new fields fly in
// "Reduce motion" skips all of it: the tab just switches.
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");
const joinCard = document.querySelector(".join-card");
const mascot = joinCard.querySelector(".mascot");
const logoEl = joinCard.querySelector(".logo");
const authBody = $("authBody");

const TAGLINES = { login: "Welcome back! Log in to jump in.", signup: "New here? Make an account." };
const PALETTE = ["#2D6BFF", "#FFD23F", "#FF6FA5", "#35D07F", "#5CCBFF", "#FF8A2B", "#8B5CF6"];
const INK = "#1B1230";
const EASE_OUT = "cubic-bezier(.2, .8, .25, 1)";
const EASE_IN = "cubic-bezier(.55, 0, .9, .5)";
const EASE_BACK_IN = "cubic-bezier(.36, 0, .66, -.5)";     // pulls back a little, then goes
const EASE_POP = "cubic-bezier(.3, 1.6, .5, 1)";           // overshoots, then settles
const EASE_SPRING = "cubic-bezier(.3, 1.3, .5, 1)";        // a gentler overshoot, for the box height

// BISCORD -> one span per letter (the heading keeps its name for screen readers)
logoEl.setAttribute("aria-label", logoEl.textContent);
const logoLetters = Array.from(logoEl.textContent).map((ch) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.setAttribute("aria-hidden", "true");
    span.textContent = ch;
    return span;
});
logoEl.textContent = "";
logoEl.append(...logoLetters);

// the two layers the rings and the confetti are drawn on
const fxBack = document.createElement("div");
fxBack.className = "fx-layer fx-back";
fxBack.setAttribute("aria-hidden", "true");
document.body.prepend(fxBack);
const fxFront = document.createElement("div");
fxFront.className = "fx-layer fx-front";
fxFront.setAttribute("aria-hidden", "true");
document.body.append(fxFront);

let currentTab = "login";
let switchRun = 0;          // every switch gets a number; an older one stops when a newer one starts
let switching = false;
let playing = [];           // the animations of the switch that is running

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function play(el, keyframes, options) {
    const a = el.animate(keyframes, options);
    playing.push(a);
    return a;
}
const ended = (list) => Promise.all(list.map((a) => a.finished.catch(() => {})));

// Cancels everything of the running switch and lets the box size itself again.
function settle() {
    playing.forEach((a) => { try { a.cancel(); } catch (err) { /* already gone */ } });
    playing = [];
    authBody.classList.remove("is-switching");
    authBody.style.height = "";
    switching = false;
}

function setTagline(text) {
    authTagline.textContent = "";
    text.split(" ").forEach((word, i, all) => {
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = word;
        authTagline.append(span);
        if (i < all.length - 1) authTagline.append(" ");
    });
    return Array.from(authTagline.children);
}

// The tabs: classes + aria. The yellow flood starts where you clicked (ev), the old tab drains toward the new one.
function paintTabs(which, ev) {
    const login = which === "login";
    const next = login ? tabLogin : tabSignup, prev = login ? tabSignup : tabLogin;
    if (!REDUCED.matches) {
        const r = next.getBoundingClientRect();
        const byMouse = ev && ev.detail > 0 && typeof ev.clientX === "number";
        next.style.transition = prev.style.transition = "none";     // move the start spot without animating it
        next.style.setProperty("--fx", (byMouse ? ev.clientX - r.left : r.width / 2) + "px");
        next.style.setProperty("--fy", (byMouse ? ev.clientY - r.top : r.height / 2) + "px");
        prev.style.setProperty("--fx", login ? "0%" : "100%");
        prev.style.setProperty("--fy", "50%");
        void next.offsetWidth;
        next.style.transition = prev.style.transition = "";
    }
    tabLogin.classList.toggle("active", login);
    tabSignup.classList.toggle("active", !login);
    tabLogin.setAttribute("aria-selected", login);
    tabSignup.setAttribute("aria-selected", !login);
}

// The end state of a tab, with no animation.
function applyTab(which) {
    const login = which === "login";
    loginForm.hidden = !login;
    signupForm.hidden = login;
    paintTabs(which);
    setTagline(TAGLINES[which]);
    currentTab = which;
}

// ----- the pieces -----
function tabJelly(tab, strong) {
    const k = strong ? 1 : .45;
    play(tab, [
        { scale: "1 1", rotate: "0deg" },
        { scale: (1 + .14 * k) + " " + (1 - .16 * k), rotate: (-2 * k) + "deg", offset: .22, easing: EASE_OUT },
        { scale: (1 - .06 * k) + " " + (1 + .1 * k), rotate: (1.4 * k) + "deg", offset: .5 },
        { scale: (1 + .03 * k) + " " + (1 - .02 * k), rotate: "0deg", offset: .75 },
        { scale: "1 1", rotate: "0deg" }
    ], { duration: strong ? 650 : 450, easing: "ease-in-out" });
}

// Confetti: little ink-outlined bits thrown up and out, pulled down by gravity.
function confetti(x, y, count) {
    for (let i = 0; i < count; i++) {
        const bit = document.createElement("i");
        bit.className = "fx-bit";
        const size = rand(8, 15), shape = i % 3;
        const w = shape === 2 ? size * 1.9 : size, h = shape === 2 ? size * .5 : size;
        bit.style.cssText = "width:" + w + "px;height:" + h + "px;margin:" + (-h / 2) + "px 0 0 " + (-w / 2) + "px;" +
            "left:" + x + "px;top:" + y + "px;background:" + pick(PALETTE) + ";" +
            "border-radius:" + (shape === 0 ? "50%" : shape === 1 ? "3px" : "999px");
        fxFront.append(bit);

        const angle = -Math.PI / 2 + rand(-.95, .95);
        const power = rand(170, 430), spin = rand(-720, 720), life = rand(950, 1500);
        const frames = [];
        for (let s = 0; s <= 16; s++) {
            const t = s / 16;
            frames.push({
                translate: (Math.cos(angle) * power * t * (1 - .3 * t)) + "px " + (Math.sin(angle) * power * t + 560 * t * t) + "px",
                rotate: (spin * t) + "deg",
                scale: String(Math.min(1, t * 9) * (1 - .35 * t)),
                opacity: t > .72 ? Math.max(0, 1 - (t - .72) / .28) : 1
            });
        }
        bit.animate(frames, { duration: life, easing: "linear", fill: "forwards", delay: rand(0, 90) })
            .finished.then(() => bit.remove(), () => bit.remove());
    }
}

// A ring that swells out from behind the card, like a shockwave.
function ring(x, y, color, delay) {
    const size = 90, el = document.createElement("i");
    el.className = "fx-ring";
    el.style.cssText = "width:" + size + "px;height:" + size + "px;margin:" + (-size / 2) + "px 0 0 " + (-size / 2) + "px;" +
        "left:" + x + "px;top:" + y + "px;background:" + color;
    fxBack.append(el);
    el.animate([
        { scale: ".35", opacity: .95 },
        { scale: "1.7", opacity: .7, offset: .45 },
        { scale: "3.1", opacity: 0 }
    ], { duration: 900, delay, easing: EASE_OUT, fill: "both" }).finished.then(() => el.remove(), () => el.remove());
}

// The mascot: crouch, jump, flip like a coin, land squashed, blink and grin.
function mascotJump() {
    const ms = 920;
    play(mascot, [
        { translate: "0 0", scale: "1 1", rotate: "y 0deg" },
        { translate: "0 7px", scale: "1.14 .84", rotate: "y 0deg", offset: .13, easing: EASE_OUT },
        { translate: "0 -50px", scale: ".9 1.14", rotate: "y 190deg", offset: .46, easing: EASE_IN },
        { translate: "0 2px", scale: "1.2 .78", rotate: "y 360deg", offset: .72, easing: EASE_OUT },
        { translate: "0 -10px", scale: ".96 1.06", rotate: "y 360deg", offset: .86, easing: EASE_IN },
        { translate: "0 0", scale: "1 1", rotate: "y 360deg" }
    ], { duration: ms });
    mascot.querySelectorAll(".m-eye").forEach((eye) => play(eye, [
        { scale: "1 1" }, { scale: "1 1", offset: .6 }, { scale: "1.2 .08", offset: .68 },
        { scale: ".95 1.3", offset: .8 }, { scale: "1 1" }
    ], { duration: ms, easing: "ease-in-out" }));
    mascot.querySelectorAll(".m-glint").forEach((g) => play(g, [
        { scale: "1", rotate: "0deg" }, { scale: "1", rotate: "0deg", offset: .6 },
        { scale: "1.9", rotate: "90deg", offset: .8 }, { scale: "1", rotate: "0deg" }
    ], { duration: ms, easing: "ease-in-out" }));
    mascot.querySelectorAll(".m-cheek").forEach((c) => play(c, [
        { scale: "1" }, { scale: "1", offset: .66 }, { scale: "1.85", offset: .78, easing: EASE_OUT },
        { scale: "1.15", offset: .9 }, { scale: "1" }
    ], { duration: ms }));
    mascot.querySelectorAll(".m-mouth").forEach((m) => play(m, [
        { scale: "1 1" }, { scale: ".8 .6", offset: .12 }, { scale: ".8 .6", offset: .5 },
        { scale: "1.4 2", offset: .74, easing: EASE_OUT }, { scale: "1.15 1.3", offset: .9 }, { scale: "1 1" }
    ], { duration: ms, easing: "ease-in-out" }));

    // rings from the mascot's feet at the moment it lands
    const r = mascot.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height * .85;
    [["#FFD23F", 0], ["#FF6FA5", 90], ["#5CCBFF", 180]].forEach((c) => ring(x, y, c[0], ms * .66 + c[1]));
}

// BISCORD: a wave of hops, every letter flashing through the palette.
function logoWave() {
    logoLetters.forEach((letter, i) => {
        const lean = (i % 2 ? -1 : 1) * 11;
        play(letter, [
            { translate: "0 0", scale: "1 1", rotate: "0deg", color: PALETTE[0] },
            { translate: "0 5px", scale: "1.14 .78", rotate: "0deg", color: PALETTE[0], offset: .14, easing: EASE_OUT },
            { translate: "0 -28px", scale: ".9 1.16", rotate: lean + "deg", color: PALETTE[(i + 1) % PALETTE.length], offset: .44, easing: EASE_IN },
            { translate: "0 0", scale: "1.18 .8", rotate: "0deg", color: PALETTE[(i + 4) % PALETTE.length], offset: .68, easing: EASE_OUT },
            { translate: "0 -6px", scale: ".98 1.05", rotate: (-lean / 3) + "deg", color: PALETTE[0], offset: .84, easing: EASE_IN },
            { translate: "0 0", scale: "1 1", rotate: "0deg", color: PALETTE[0] }
        ], { duration: 860, delay: 150 + i * 62 });
    });
}

// The card lifts off its shadow, tilts toward the way the form is going, then drops back.
function cardLift(dir) {
    play(joinCard, [
        { translate: "0 0", rotate: "0deg", scale: "1 1", boxShadow: "10px 10px 0 " + INK },
        { translate: "0 -16px", rotate: (dir * 1.6) + "deg", scale: "1.012 .99", boxShadow: "17px 27px 0 " + INK, offset: .3, easing: EASE_OUT },
        { translate: "0 4px", rotate: (-dir * .9) + "deg", scale: ".992 1.006", boxShadow: "8px 6px 0 " + INK, offset: .66 },
        { translate: "0 0", rotate: "0deg", scale: "1 1", boxShadow: "10px 10px 0 " + INK }
    ], { duration: 1150, easing: "ease-in-out" });
}

// The flat list of things in a form that fly: its children, with the button row split into button + status.
function formPieces(form) {
    const out = [];
    Array.from(form.children).forEach((child) => {
        if (child.hidden) return;
        if (child.classList.contains("join-actions")) out.push(...Array.from(child.children));
        else out.push(child);
    });
    return out;
}

// How each kind of piece flies in.
function enterPiece(el, i, dir, delay) {
    const side = dir * (i % 2 ? 1 : -1);
    const opts = { duration: 640, delay, easing: EASE_POP, fill: "backwards" };
    if (el.classList.contains("field")) {
        const from = dir > 0 ? "inset(0 100% 0 0 round 14px)" : "inset(0 0 0 100% round 14px)";
        return play(el, [
            { clipPath: from, translate: (dir * 34) + "px 0", scale: "1 .86", opacity: .2 },
            { clipPath: "inset(0 0 0 0 round 14px)", translate: "0 0", scale: "1 1", opacity: 1 }
        ], { duration: 640, delay, easing: EASE_OUT, fill: "backwards" });
    }
    if (el.tagName === "LABEL") {
        return play(el, [
            { translate: (dir * 70) + "px 0", rotate: (dir * 5) + "deg", opacity: 0 },
            { translate: "0 0", rotate: "0deg", opacity: 1 }
        ], opts);
    }
    if (el.classList.contains("hint")) {
        return play(el, [
            { translate: "0 -12px", scale: ".92", opacity: 0 },
            { translate: "0 0", scale: "1", opacity: 1 }
        ], opts);
    }
    if (el.classList.contains("btn")) {                  // jumps up with a squash and stretch
        return play(el, [
            { translate: "0 46px", scale: ".55 1.35", opacity: 0 },
            { translate: "0 -14px", scale: "1.1 .9", opacity: 1, offset: .55, easing: EASE_OUT },
            { translate: "0 0", scale: "1 1", opacity: 1 }
        ], { duration: 720, delay, easing: EASE_IN, fill: "backwards" });
    }
    if (el.classList.contains("pill")) {                 // pops in with a spin
        return play(el, [
            { scale: "0", rotate: "-200deg", opacity: 0 },
            { scale: "1", rotate: "0deg", opacity: 1 }
        ], opts);
    }
    return play(el, [
        { translate: (side * 50) + "px 0", rotate: (side * 4) + "deg", scale: ".85", opacity: 0 },
        { translate: "0 0", rotate: "0deg", scale: "1", opacity: 1 }
    ], opts);
}

async function switchTab(which, ev) {
    // an unfinished switch is finished on the spot, so the new one starts from a clean state
    if (switching) { settle(); applyTab(currentTab); }
    const run = ++switchRun;
    switching = true;
    const dir = which === "signup" ? 1 : -1;            // the content travels toward the right when going to sign up
    const fromForm = which === "signup" ? loginForm : signupForm;
    const toForm = which === "signup" ? signupForm : loginForm;
    const nextTab = which === "signup" ? tabSignup : tabLogin;
    const prevTab = which === "signup" ? tabLogin : tabSignup;
    currentTab = which;

    // freeze the box at its current height, so the forms can leave without the card jumping
    authBody.classList.add("is-switching");
    const fromH = authBody.getBoundingClientRect().height;
    authBody.style.height = fromH + "px";

    // 1. everything that does not wait for the form
    paintTabs(which, ev);
    tabJelly(nextTab, true);
    tabJelly(prevTab, false);
    const tr = nextTab.getBoundingClientRect();
    const byMouse = ev && ev.detail > 0 && typeof ev.clientX === "number";
    confetti(byMouse ? ev.clientX : tr.left + tr.width / 2, byMouse ? ev.clientY : tr.top + tr.height / 2, 24);
    mascotJump();
    logoWave();
    cardLift(dir);

    // 2. the tagline's words fly out
    const oldWords = authTagline.querySelector(".w") ? Array.from(authTagline.children) : setTagline(authTagline.textContent);
    const wordExits = oldWords.map((w, i) => play(w, [
        { translate: "0 0", rotate: "0deg", scale: "1", opacity: 1, filter: "blur(0px)" },
        { translate: "0 -18px", rotate: ((i % 2 ? -1 : 1) * 9) + "deg", scale: ".5", opacity: 0, filter: "blur(4px)" }
    ], { duration: 300, delay: i * 40, easing: EASE_BACK_IN, fill: "forwards" }));

    // 3. the old form's pieces fly out, one after the other
    const outs = formPieces(fromForm);
    const gap = Math.min(30, 170 / Math.max(1, outs.length));
    const exits = outs.map((el, i) => play(el, [
        { translate: "0 0", rotate: "0deg", scale: "1", opacity: 1, filter: "blur(0px)" },
        { translate: (-dir * 80) + "px " + ((i % 2 ? -1 : 1) * 8) + "px", rotate: (-dir * (i % 2 ? 7 : -7)) + "deg", scale: ".7", opacity: 0, filter: "blur(5px)" }
    ], { duration: 320, delay: i * gap, easing: EASE_BACK_IN, fill: "forwards" }));
    await ended(exits.concat(wordExits));
    if (run !== switchRun) return;

    // 4. swap: the old form goes, the new one is there but every piece is already hidden by its entrance
    exits.forEach((a) => a.cancel());
    fromForm.hidden = true;
    toForm.hidden = false;
    clearAuthErrors();
    authBody.style.height = "auto";
    const toH = authBody.getBoundingClientRect().height;
    authBody.style.height = fromH + "px";
    void authBody.offsetHeight;

    const words = setTagline(TAGLINES[which]);
    words.forEach((w, i) => play(w, [
        { translate: "0 24px", rotate: ((i % 2 ? -1 : 1) * 10) + "deg", scale: ".4", opacity: 0, filter: "blur(4px)" },
        { translate: "0 0", rotate: "0deg", scale: "1", opacity: 1, filter: "blur(0px)" }
    ], { duration: 560, delay: 60 + i * 70, easing: EASE_POP, fill: "backwards" }));

    const ins = formPieces(toForm);
    const gapIn = Math.min(60, 280 / Math.max(1, ins.length));
    const enters = ins.map((el, i) => enterPiece(el, i, dir, 120 + i * gapIn));
    const grow = play(authBody, [{ height: fromH + "px" }, { height: toH + "px" }],
        { duration: 700, easing: EASE_SPRING, fill: "forwards" });
    (toForm === signupForm ? signupUser : loginUser).focus({ preventScroll: true });

    await ended(enters.concat(grow));
    if (run !== switchRun) return;
    settle();
}

function showAuthTab(which, ev) {
    if (REDUCED.matches) {
        clearAuthErrors();
        applyTab(which);
    } else if (which !== currentTab) {
        switchTab(which, ev);              // (a visible error flies out with its form)
        return;
    } else if (!switching) {
        clearAuthErrors();
        tabJelly(which === "login" ? tabLogin : tabSignup, true);      // already here: just a friendly wobble
    } else {
        return;                            // the same tab again while it is still arriving
    }
    (which === "login" ? loginUser : signupUser).focus();
}
tabLogin.addEventListener("click", (e) => showAuthTab("login", e));
tabSignup.addEventListener("click", (e) => showAuthTab("signup", e));

// Log in / sign up are sent to the server (app.bzg) as packets and answered with
// AUTHOK (you're in) or AUTHERR (with the reason).
function authenticate(type, name, password) {
    clearAuthErrors();
    if (state !== "online") return showAuthError("Not connected yet. Wait for the green dot.");
    authBusy = true;
    setStatus(state);
    clearTimeout(authTimer);
    authTimer = setTimeout(() => failAuth("The server didn't answer. Is app.bzg running?"), AUTH_WAIT_MS);
    if (!sendPacket(type, myId, name, mySecret + "|" + password)) failAuth("Not connected yet. Wait for the green dot.");
}

function failAuth(text) {
    clearTimeout(authTimer);
    authBusy = false;
    setStatus(state);
    showAuthError(text);
}

loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (authBusy) return;
    const name = loginUser.value.trim();
    if (!name || !loginPass.value) return showAuthError("Enter your username and password.");
    authenticate("LOGIN", name, loginPass.value);
});

signupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (authBusy) return;
    const name = signupUser.value.trim();
    if (name.length < 2 || name.length > 16) return showAuthError("Username needs 2 to 16 characters.");
    if (name.indexOf("|") >= 0) return showAuthError("Usernames can't contain |");
    if (!signupPass.value) return showAuthError("Please choose a password.");
    if (signupPass.value !== signupConfirm.value) return showAuthError("Passwords don't match.");
    authenticate("SIGNUP", name, signupPass.value);
});

// A message left by the chat page (for example "That account is already online ...").
const flash = takeFlash();
if (flash) showAuthError(flash);

connect();
