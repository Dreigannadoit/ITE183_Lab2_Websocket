# Chatterbox – Bonezegei WebSocket Chat (ITE183 Lab 2)

A real-time group chat app with a Discord-style layout: channels on the left, the conversation in the middle, and who's online on the right. The server is a small relay written in **Bonezegei Script Language (`.bzg`)**. It serves a cartoon-style browser client with heavy outlines and a semi-3D look.

## Features

- **Accounts**: a **Sign up** page (username, password, confirm password) and a **Log in** page (username, password). Usernames are unique (case-insensitive), 2–16 characters, no `|`
- **Saved chat**: every text message is stored, so when you log in again the earlier conversation in each channel is already there (last 300 per channel)
- **Log out** button in your user card
- The same account can't be online twice at once (a second login is refused until the first tab closes)
- Join and leave announcements
- Live "Online" list, updated whenever someone joins or leaves
- **Channels** (`#general`, `#random`, `#help`, `#memes`): each has its own messages, header and topic. Switch with a click or **Alt + Up/Down**
- **Unread markers**: a channel you aren't viewing shows a dot when it has new messages, and a pink number badge when someone **@mentioned** you
- **@mentions**: type `@Name` (or click a person in the Online list to insert it). Mentioned names are highlighted, and messages that mention you get a yellow highlight
- **Drafts**: text you typed but didn't send is kept per channel when you switch
- **Pictures**: send with the picture button, by pasting (Ctrl + V), or by dragging a file onto the chat. Everyone in the channel sees an animated placeholder with a progress bar while it arrives, then the picture. Click a picture to see it bigger
- **Memory saving**: pictures you aren't looking at are released from memory (scrolled out of view, in another channel, or the tab hidden for 5 seconds). They reload, with the loading animation, when you come back
- Messages from the same person within 5 minutes are **grouped** under one name and avatar, with a **Today / Yesterday** date divider
- Chat bubbles with sender name, timestamp and a colored initial avatar
- Your name and connection status in a user card at the bottom of the channel list
- Auto-reconnect: if the connection drops, the client retries and tells everyone it is back
- Live **typing indicator**, per channel: while someone types, everyone else *in that channel* sees bouncing dots and "Name is typing" under them ("Name and Name are typing" for two people, and so on)
- Collapsible **Console** at the bottom left: a small `>_` square when closed that grows open with an animation. It shows the raw `[System]`, `[Server]` and `[Client]` traffic, like the original lab UI (handy for debugging connections). Drag it by its purple header (or the dotted grip) to put it anywhere; double-click the grip or press Escape on it to send it back to the bottom left. Arrow keys move it too, and it remembers its position.
- Responsive layout: on phones the channel list and the online list become slide-in drawers (the **Channels** and **Who's here** buttons)

## Project Structure

```
.
├── start-server.bat     # Windows launcher: firewall rule, shows your IP, runs the server
├── app.bzg              # Server: HTTP routes + WebSocket relay (live chat)
├── server/
│   └── accounts.js      # Node server: sign up, log in, chat history (port 8001)
├── database/            # Created automatically on first run
│   ├── users.js         # All accounts: id, username, password, createdAt
│   └── chatlogs.js      # All saved messages, per channel
├── package.json
├── lib/
│   ├── http.bzg         # Loads the native http module
│   ├── http.json        # Method reference for the http module
│   └── http/http.dll    # Native HTTP/WebSocket library
├── public/
│   ├── index.html       # Chatterbox client (join screen + chat screen)
│   └── 404.html
└── README.md
```

## Requirements

- Windows (the native module is a `.dll`)
- The **Bonezegei** interpreter, available as `bonezegei`
- **Node.js** (any recent version, no packages to install) for accounts and saved chat
- A modern web browser

## Getting Started

Two programs need to be running (`start-server.bat` starts both for you):

```bash
bonezegei app.bzg          # live chat + the web page   (npm start)
node server/accounts.js    # accounts + saved chat      (npm run accounts)
```

Open <http://localhost:8000>, create an account on the **Sign up** tab and start chatting. Open a second tab or device on the same network (use the host machine's IP instead of `localhost`) to chat with yourself.

## Accounts and saved chat

`server/accounts.js` is a small Node server on port **8001** (built-in modules only). The page talks to it with `fetch`, using the same host name it was opened from.

| Route | What it does |
| ----- | ------------ |
| `POST /api/signup` | Checks the form (2–16 character name, password, passwords match, name not taken). On success it **rewrites `database/users.js`** and logs the person in |
| `POST /api/login` | Checks username and password and returns a session token |
| `GET /api/history` | Returns the saved messages of every channel (needs the token) |
| `POST /api/messages` | Saves one message (needs the token). The browser calls it every time you send a message |

`database/users.js` and `database/chatlogs.js` are real JavaScript modules (`module.exports = [...]`), rewritten whole each time. You can open and read them, or `require()` them from another script. Delete a file to reset it.

**This is a personal project, so there is no security:** passwords are saved as plain text, anyone who can open port 8001 can reach the API, and the session token lives only in server memory (restarting `accounts.js` means people log in again).

**What is saved:** text messages only. Pictures, join/leave notices and typing dots are live only, as before. If the accounts server is down, the page says so at login.

**Settings:** `PORT`, `CHANNELS` and `HISTORY_PER_CHANNEL` at the top of `server/accounts.js`. If you add a channel in `public/app.js`, add it to `CHANNELS` there too.

## How It Works

The Bonezegei server is a **plain relay**: whatever one client sends, it broadcasts to every connected client. It stores nothing and parses nothing. Live chat logic lives in `public/app.js`; accounts and saved messages are handled by `server/accounts.js`.

This is on purpose. An earlier version kept the username list on the server in a BSL array, and it misbehaved (messages were treated as new usernames, and the server stalled when two people joined together). The relay design only uses `sendAll`, which is the same thing the original lab server did.

### Message format

Every message is plain text shaped like `TYPE|id|name|payload`. Each browser tab has a random `id`.

| Type | Sent when | Meaning |
| ---- | --------- | ------- |
| `CLAIM` | You press Join | "I'd like this username" |
| `TAKEN` | Someone already has that name | Tells the claimer to pick another. If two people claim the same name at once, the lower `id` wins |
| `HELLO` | Your claim wasn't challenged for 0.7 seconds | You joined. Everyone replies with `HERE` so you learn who is online |
| `HERE` | Replying to `HELLO`, and every 20 seconds | "I'm online" |
| `MSG` | You send a message | Payload is `channel\|text`, for example `random\|hello` |
| `TYPING` | You type in the message box | Payload is `channel\|1` while typing (repeated every 2.5 seconds), `channel\|0` when you stop, clear the box or switch channel. Sending a message also hides your dots. Receivers hide them after 5 seconds of silence. These packets are left out of the Console to avoid flooding it |
| `IMGH` | You send a picture | Header: `channel\|picId\|packets\|mime\|bytes\|width\|height`. Receivers show the placeholder |
| `IMGC` | Right after `IMGH` | One piece of the picture: `picId\|index\|base64data`. These are left out of the Console |
| `BYE` | You close the tab | You left. Clients also drop anyone silent for 2.5 minutes |

If a message arrives without a known channel in front (for example from an older copy of the page), it is shown in `#general`.

## Pictures

**Sending.** The picture is shrunk to at most 1024 pixels on its longest side and compressed to JPEG under about 160 KB (a typical photo ends up at 50–150 KB). Small GIFs under 160 KB are sent unchanged so they keep moving. The result is cut into packets of 1,500 characters and sent with a short pause every few packets, so the server isn't flooded.

**Receiving.** The header packet creates a placeholder with a striped loading animation and a progress bar ("Receiving 45%"). When the last packet arrives the picture is rebuilt, decoded, and shown. If nothing arrives for 15 seconds, the placeholder turns pink ("Picture didn't arrive").

**Memory.** Browsers keep decoded pictures in memory, and that is the expensive part. Each picture is only decoded while it is on screen (or within about a screen of it). When it scrolls away, you switch channel, or the tab stays hidden for 5 seconds, the picture is released. Scrolling back shows the loading animation briefly and reloads it from the small compressed copy kept in the page. Past 40 MB of kept pictures, the oldest are dropped and show "Removed to save memory".

**Settings** are the constants at the top of the script in `public/index.html`: `MAX_DIM`, `MAX_IMG_BYTES`, `CHUNK_CHARS`, `MAX_STORE_BYTES`, `MIN_LOADING_MS`, `HIDDEN_UNLOAD_MS`.

**Limits.**
- Pictures live only in the browsers that were online when they were sent. Refresh the page and they are gone, and people who join later don't see them.
- Pictures are compressed, so quality is lower than the original. Transparent PNGs get a white background, and animated GIFs over 160 KB become still.
- If pictures never show up on your server, it may not accept large packets. Lower `CHUNK_CHARS` to 800, then 400.

## Server Handlers (`app.bzg`)

| Handler | Behavior |
| ------- | -------- |
| `server.get` | `/` serves `public/index.html`, anything else serves `public/404.html` |
| `server.onConnect` | Logs the connection |
| `server.onData` | Logs who sent it (not the content, since pictures are many packets) and broadcasts it to everyone with `sendAll` |
| `server.onDisconnect` | Logs the disconnection |

## Limitations

- Because the server doesn't check anything, a person who edits the page's code could pretend to be someone else. That's fine for a lab or a class demo, but not for real use.
- If someone's browser crashes (no `BYE`), their name stays in the list for up to 2.5 minutes.
- Pictures are not saved (only text), so they are gone after a refresh.
- Messages sent by others while your connection was down are not filled in until you log in again.

## Design

Palette (defined as CSS variables at the top of `public/index.html`):

| Role | Colors |
| ---- | ------ |
| Primary | Bubble Blue `#2D6BFF`, Sunny Yellow `#FFD23F` |
| Secondary | Mint Green `#35D07F`, Bubblegum Pink `#FF6FA5`, Sky Cyan `#5CCBFF` |
| Complementary | Orange `#FF8A2B` (opposite blue), Purple `#8B5CF6` (opposite yellow) |
| Neutrals | Ink `#1B1230`, Paper `#FFF6DF`, White |

Fonts are Lilita One (headings) and Nunito (text), loaded from Google Fonts. Offline, the page falls back to system rounded fonts.

## Hosting on Your Local Network

Other phones and laptops on the same Wi-Fi can join the chat through your PC's IP address.

1. **Start the servers with `start-server.bat`** (double-click it). The first time, right-click it and choose **Run as administrator** so it can open the Windows Firewall for ports 8000 and 8001. After that, a normal double-click is enough.
2. The window prints the addresses to share, for example `http://192.168.1.23:8000`. Use the one starting with `192.168` or `10.`.
3. On the other device, connected to the **same Wi-Fi**, type that address into the browser.
4. Pick different usernames and chat.

Prefer the terminal? The manual steps are:

```bash
ipconfig                     # find your "IPv4 Address"
bonezegei app.bzg            # start the server
```

and, once, in an **administrator** terminal:

```bash
netsh advfirewall firewall add rule name="Chatterbox LAN TCP 8000" dir=in action=allow protocol=TCP localport=8000 profile=any
```

To remove the firewall rule later:

```bash
netsh advfirewall firewall delete rule name="Chatterbox LAN TCP 8000"
```

When Windows asks whether to let `bonezegei` through the firewall, allow it.

The page picks up the address it was opened from, so no code changes are needed for other devices.

## Customization

- **Add or rename channels:** edit the `CHANNELS` list near the top of the script in `public/index.html`. Every browser needs the same list. The server doesn't need to change.

- **Change the port:** edit `http(8000)` in `app.bzg`. The client uses the page's own host and port, so it follows automatically.
- **Presence timing:** adjust `HEARTBEAT_MS` and `STALE_MS` at the top of the script in `public/index.html`.
- **Recolor the app:** edit the variables in `:root` in `public/index.html`.

## Troubleshooting

- **Console shows messages but the chat area stays empty:** open the Console and look at the `[Server]` lines. Chatterbox messages look like `HELLO|...` or `Alice says: Hello`. If you see a `[System] Ignored a message...` line, the server is running an old `app.bzg`. Replace the one in the project root with the relay version and restart. The page also understands the original lab server's `User <n> says: ...` format, so chat still works with it.

- **Works on the PC but not on other devices:** open the page on the PC using your IP address (not `localhost`). If that works but other devices fail, it's the firewall (run the `.bat` as administrator once) or the Wi-Fi. Guest networks and some routers block devices from talking to each other ("client isolation" or "AP isolation").
- **Phone is on mobile data:** turn mobile data off so it uses the same Wi-Fi as the PC.
- **Wrong IP:** VPNs, WSL and VirtualBox add extra addresses. Use the one that starts with `192.168` or `10.`.

- **Status shows Offline:** make sure the server is running. The client retries every 2 seconds.
- **"Can't reach the account server":** `node server/accounts.js` isn't running (or port 8001 is blocked by the firewall for other devices).
- **"That account is already online":** that login is open in another tab or device. Wait a few minutes if it was a crashed tab.
- **Port already in use:** close the other program or change the port.

## License

MIT