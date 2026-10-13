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
            saveSession(myId, m.name);
            location.href = "/chat";
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

function showAuthTab(which) {
    const login = which === "login";
    loginForm.hidden = !login;
    signupForm.hidden = login;
    tabLogin.classList.toggle("active", login);
    tabSignup.classList.toggle("active", !login);
    tabLogin.setAttribute("aria-selected", login);
    tabSignup.setAttribute("aria-selected", !login);
    authTagline.textContent = login ? "Welcome back! Log in to jump in." : "New here? Make an account.";
    clearAuthErrors();
    (login ? loginUser : signupUser).focus();
}
tabLogin.addEventListener("click", () => showAuthTab("login"));
tabSignup.addEventListener("click", () => showAuthTab("signup"));

// Log in / sign up are sent to the server (app.bzg) as packets and answered with
// AUTHOK (you're in) or AUTHERR (with the reason).
function authenticate(type, name, password) {
    clearAuthErrors();
    if (state !== "online") return showAuthError("Not connected yet. Wait for the green dot.");
    authBusy = true;
    setStatus(state);
    clearTimeout(authTimer);
    authTimer = setTimeout(() => failAuth("The server didn't answer. Is app.bzg running?"), AUTH_WAIT_MS);
    if (!sendPacket(type, myId, name, password)) failAuth("Not connected yet. Wait for the green dot.");
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
