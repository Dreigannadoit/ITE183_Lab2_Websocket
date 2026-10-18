# BISCORD

A real-time, Discord-style chat web app written entirely in **BSL (Bonezegei Scripting Language)**. A single script, `app.bzg`, serves the web pages, relays live chat over WebSockets, manages user accounts and stores all chat history in a SQLite database. No Node.js is needed to run it.

---

## 1. Project Description

BISCORD lets people on the same network sign up, log in and chat in real time in themed channels from any phone or laptop browser.

### Features

- **Accounts**: sign up and log in with a username (2–16 characters, case-insensitive and unique) and a password.
- **Four channels**: `#general`, `#random`, `#help` and `#memes`.
- **Live messaging**: messages are broadcast to everyone through the WebSocket server (limit: 300 characters per message).
- **Chat history**: messages are saved in SQLite. The newest 100 messages per channel are loaded after login or a server restart.
- **Picture sharing**: attach or drag-and-drop images (JPEG, PNG, GIF, WebP). They are compressed in the browser, sent in chunks, saved in the database and reloaded when they scroll into view.
- **Typing indicator**: see who is typing in each channel.
- **Member panel**: shows who is online and how many accounts are registered.
- **Connection console**: a collapsible panel in the chat page that shows the raw packets, handy for debugging.
- **Responsive layout**: works on phones and desktops.

### How it works

The server is one BSL program listening on **port 8000**. The same port handles both plain HTTP (pages and assets) and WebSocket traffic (chat, accounts, history). Everything the clients send is a text packet shaped like:

```
TYPE|id|name|payload
```

| Packet (client → server) | Purpose |
| --- | --- |
| `SIGNUP`, `LOGIN` | Create an account / log in |
| `RESUME` | Chat page asks "is this tab still logged in?" |
| `LOGOUT` | Forget this login |
| `HISTORY` | Request saved messages |
| `USERS` | Request the list of registered accounts |
| `SAVE` | Store a chat message |
| `IMGH` / `IMGC` / `IMGGET` | Send a picture (header, chunks) / request a saved picture |

Anything else is treated as live chat and broadcast to all connected clients. The server replies to account and history requests only to the requesting client.

### Schematic diagram

![BISCORD schematic diagram](docs/Schematic_Diagram.jpg)

The diagram shows how the pieces fit together:

1. **Browser clients** (HTML, CSS and JavaScript) talk to the server over HTTP and WebSocket on port 8000.
2. A user must first log in or register. **Login Auth** verifies the credentials against the **BSL_SQLite database**.
3. Once verified, the user can access the services inside `app.bzg` (the Bonezegei server):
   - **Live relay**: `onData` to `sendAll` broadcasts chat packets to everyone.
   - **Page Server**: `server.get` serves the login page, chat page and assets.
   - **Accounts**: `SIGNUP` and `LOGIN` packets, backed by the user table (username, password).
   - **Chat History**: `SAVE` and `HISTORY` packets, backed by the messages table (foreign keys to both user and channel, timestamp, text) and the channel table.
   - **Picture**: `IMGH`, `IMGC` and `IMGGET` packets. Pictures are converted to Base64 for transfer and converted back to a photo when requested.

### UI design (Figma)

The interface was designed in Figma before it was built. The screenshot below shows the design file, with frames for the schematic diagram, the login page, the register page, the general chat and the voice chat lounge.

![BISCORD Figma design file](docs/Figma_Design.png)

### Project structure

```
.
├── app.bzg                 # The whole server (HTTP routes, WebSocket, accounts, history, pictures)
├── start-server.bat        # Windows launcher (checks setup, opens firewall, shows LAN URLs, auto-restarts)
├── package.json            # Project metadata and `npm start` script
├── lib/
│   ├── http.bzg            # Loads the http/socket native library (http/http.dll)
│   ├── http.json           # API description of the http/socket library
│   ├── sqlite.bzg          # Loads the SQLite native library (sqlite/sqlite.dll)
│   ├── http/http.dll
│   └── sqlite/sqlite.dll
├── docs/
│   ├── Schematic_Diagram.jpg   # Architecture diagram used in this README
│   └── Figma_Design.png        # Screenshot of the Figma UI design file
├── public/                 # Files served to the browser
│   ├── login.html          # Login / sign-up page
│   ├── chat.html           # Chat page
│   ├── 404.html            # Page shown for unknown URLs
│   ├── style.css
│   └── scripts/
│       ├── common.js       # Shared WebSocket and packet helpers
│       ├── login.js
│       └── chat.js
└── database/
    ├── chatterbox.db       # SQLite database (users, channels, messages, pictures)
    └── images/
```

---

## 2. Installation & Setup Guide

### Requirements

- **Windows** (the bundled libraries are `.dll` files and the launcher is a `.bat` file)
- The **BSL interpreter** (`bonezegei` command)
- The **Socket (HTTP/WebSocket) library** and the **SQLite library**, both bundled in `lib/`
- A modern web browser

### Step 1: Install BSL

1. Obtain the BSL (Bonezegei) interpreter package from your course or instructor materials.
2. Install it and add it to your system **PATH**.
3. Open a new Command Prompt and check that the command is found:

   ```bat
   where bonezegei
   ```

   If it prints a path, BSL is installed correctly. If it says it could not find `bonezegei`, the interpreter is not on your PATH yet.

### Step 2: Get the project

Download or clone the repository, then open a terminal inside the project folder (the one containing `app.bzg`).

```bat
cd path\to\BISCORD
```

### Step 3: Install the socket library (and SQLite)

Both libraries are already included in `lib/`, so there is nothing to download. They are loaded by the server's first lines:

```js
include("lib/http.bzg");     // socket / HTTP + WebSocket library
include("lib/sqlite.bzg");   // SQLite library
var server = http(8000);     // start listening on port 8000
```

Each `.bzg` file loads its native DLL:

| File | Loads |
| --- | --- |
| `lib/http.bzg` | `http/http.dll` (Socket library v1.0.1: GET/POST routes and WebSocket send/receive) |
| `lib/sqlite.bzg` | `sqlite/sqlite.dll` (SQLite database access) |

Make sure the `lib/` folder keeps its structure (`lib/http/http.dll` and `lib/sqlite/sqlite.dll`), because the `.bzg` files refer to these relative paths.

> The `database/` folder must exist next to `app.bzg`. It already contains `chatterbox.db`; the tables are created automatically on startup if they are missing. Uploaded pictures are stored inside the database.

### Step 4: Run the server

**Option A: Windows launcher (recommended)**

Double-click `start-server.bat`, or run it from the terminal:

```bat
start-server.bat
```

The launcher will:

1. Check that `bonezegei` and `app.bzg` are found.
2. Create `database\images` if needed.
3. Check for a Windows Firewall rule for port 8000.
4. Print the addresses other devices can open, for example `http://192.168.1.20:8000`.
5. Start the server and restart it automatically if it ever exits.

> **First run, for LAN access:** right-click `start-server.bat` → **Run as administrator** once. This adds the firewall rule (`BISCORD LAN TCP 8000`) so phones and other laptops can connect. After that you can run it normally.

**Option B: Run the script directly**

```bat
bonezegei app.bzg
```

or, if you have npm available:

```bat
npm start
```

When the server starts correctly, the console prints something like:

```
Database ready: database/chatterbox.db (N user(s), N message(s))
```

If you see `ERROR: database ... is not working`, check that the `database` folder exists.

Keep the console window open while people are chatting. Press **Ctrl+C** to stop the server.

---

## 3. Usage Instructions

Replace `localhost` with the server's LAN IP (for example `192.168.1.20`) when opening the app from another device on the same Wi-Fi.

### Page endpoints

| URL | What you get |
| --- | --- |
| `http://localhost:8000/` | Login / sign-up page |
| `http://localhost:8000/login` | Same login / sign-up page |
| `http://localhost:8000/login.html` | Same login / sign-up page |
| `http://localhost:8000/chat` | Chat page (redirects to the login page if you are not logged in) |
| `http://localhost:8000/chat.html` | Same chat page |
| `http://localhost:8000/anything-else` | 404 page ("404 - Page Not Found") |

### Static asset endpoints

These are loaded automatically by the pages, but you can open them in the browser to check they are being served:

| URL | File |
| --- | --- |
| `http://localhost:8000/style.css` | Stylesheet |
| `http://localhost:8000/scripts/common.js` | Shared WebSocket helpers |
| `http://localhost:8000/scripts/login.js` | Login page script |
| `http://localhost:8000/scripts/chat.js` | Chat page script |

### WebSocket endpoint

The chat page connects to `ws://<host>:8000`. Accounts, history, pictures and live chat all travel over this one connection, so no other ports or REST endpoints are required.

### Walkthrough

1. **Open the app** at `http://localhost:8000/`.
2. **Sign up**: choose a username (2–16 characters) and a password, then submit. Next time, use **Log in**.
3. **Chat**: you land on `#general`. Pick another channel (`#random`, `#help`, `#memes`) from the left sidebar.
4. **Send a message**: type in the box at the bottom and press **Enter** or click **Send** (max 300 characters).
5. **Send a picture**: click the attach button, or drag and drop an image onto the chat. Pictures are resized and compressed automatically.
6. **See who is around**: the members panel on the right shows online users and the total number of registered accounts. A "typing" indicator appears when someone is writing.
7. **Debug**: expand the connection console at the bottom to watch packets going back and forth.
8. **Log out** with the log-out button in the sidebar.

To test live chat, open the app in two different browsers (or one normal and one private window) and log in with two different accounts.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| `"bonezegei" was not found on this PC` | Install BSL and add it to PATH, then open a new terminal. |
| Other devices cannot connect | Run `start-server.bat` as administrator once, and make sure all devices are on the same Wi-Fi. |
| Blank chat or "session ended" message | Make sure the server is running the latest `app.bzg`, then log in again. |
| `ERROR: database ... is not working` | Confirm the `database/` folder exists next to `app.bzg`. |
| Port 8000 already in use | Close the other program using it, or change the `http(8000)` value in `app.bzg` (and `PORT` in `start-server.bat`). |

---

## Notes & Limitations

- This is a personal / learning project: **passwords are stored as plain text** and there is no real security. Do not reuse a real password.
- Messages are limited to 300 characters; pictures are compressed to roughly 160 KB before sending.
- The channel list is defined in `app.bzg` (`CHANNELS`) and must be kept in sync with the client.

## License

MIT