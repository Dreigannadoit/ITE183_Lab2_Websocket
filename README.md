# BISCORD – Bonezegei WebSocket Chat (ITE183 Lab 2)

A real-time group chat app with a Discord-style layout: channels on the left, the conversation in the middle, and who's online on the right. The whole server is one file written in **Bonezegei Script Language (`.bzg`)**: `app.bzg` serves the page, relays live chat, and handles accounts and saved chat. There is no Node.js. It serves a cartoon-style browser client with heavy outlines and a semi-3D look.

## Features

- **Accounts**: a **Sign up** page (username, password, confirm password) and a **Log in** page (username, password). Usernames are unique (case-insensitive), 2–16 characters, no `|`
- **Saved chat**: every text message is stored, so when you log in again the earlier conversation in each channel is already there (the last 100 per channel are sent on login; up to 2000 messages are kept in total)
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
├── app.bzg              # The entire server: web page, live chat relay, accounts, saved chat
├── database/            # Only used if PERSIST = true in app.bzg
│   ├── images/          # One .txt per saved picture (base64)
│   ├── users.txt        # Accounts: username|password (created on first signup)
│   └── chatlogs.txt     # Saved messages: channel|user|timestamp|text
├── package.json
├── lib/
│   ├── http.bzg         # Loads the native http module
│   ├── http.json        # Method reference for the http module
│   └── http/http.dll    # Native HTTP/WebSocket library
├── public/
│   ├── index.html       # BISCORD client (join screen + chat screen)
│   ├── app.js           # Client logic
│   ├── style.css        # Cartoon-style theme
│   └── 404.html
└── README.md
```

## Requirements

- Windows (the native module is a `.dll`)
- The **Bonezegei** interpreter, available as `bonezegei` (tested with v1.3.3)
- A modern web browser

## Getting Started

One program does everything (`start-server.bat` runs it for you):

```bash
bonezegei app.bzg          # page + live chat + accounts + saved chat   (npm start)
```

Open <http://localhost:8000>, create an account on the **Sign up** tab and start chatting. Open a second tab or device on the same network (use the host machine's IP instead of `localhost`) to chat with yourself.

## Accounts and saved chat

Accounts and history use the **same WebSocket as the chat**, so only port **8000** is involved. They are extra packet types that `app.bzg` answers to the sender only (they are never broadcast):

| Client sends | Server answers | What it does |
| ------------ | -------------- | ------------ |
| `SIGNUP\|id\|username\|password` | `AUTHOK` or `AUTHERR` | Checks the name (2–16 characters, not taken, case-insensitive) and a password was given, then creates the account and logs the tab in |
| `LOGIN\|id\|username\|password` | `AUTHOK` or `AUTHERR` | Checks username and password |
| `HISTORY\|id\|\|` | `HIST` per message, then `HISTEND` | Returns the saved messages (last `HISTORY_PER_CHANNEL` per channel) |
| `SAVE\|id\|channel\|timestamp\|text` | `SAVEERR` only if not logged in | Saves one message. The browser sends it every time you send a message |

The server remembers which tab (`id`) logged in, so `SAVE` and `HISTORY` only work after a login.

**Where the data lives.** Accounts and messages are kept in lists inside `app.bzg`, so by default they last until the server stops. To keep them across restarts set `PERSIST = true` at the top of `app.bzg`; they are then written to `database/users.txt` and `database/chatlogs.txt` (using BSL's `readFile` / `writeFile`) and read back on start. The `database/` folder must exist. Messages are held in a fixed-size ring buffer, so once `MAX_LOG` (2000) messages are stored the oldest is overwritten.

Older versions of this project stored accounts in `database/users.js` and `chatlogs.js` through Node. Those files are no longer used and can be deleted. To keep an old account, add a line `username|password` to `database/users.txt`.

**This is a personal project, so there is no security:** passwords are saved as plain text and the login is tied to the browser tab's random id.

**What is saved:** text messages and pictures. Join/leave notices and typing dots are live only. Each picture is written to `database/images/<picId>.txt` (base64 text, about 70-220 KB) and listed in `chatlogs.txt` as `[img]picId,mime,bytes,width,height`. After you log in, saved pictures are downloaded one by one as they scroll into view (`IMGGET` request, `PICH`/`PICC` packets back to you only). Saving pictures needs `PERSIST = true`. Timestamps come from the sender's browser.

**Settings** (top of `app.bzg`): `CHANNELS`, `MAX_TEXT`, `HISTORY_PER_CHANNEL`, `MAX_LOG`, `PERSIST`. If you add a channel in `public/app.js`, add it to `CHANNELS` there too.

## How It Works

The Bonezegei server is a **plain relay**: whatever one client sends, it broadcasts to every connected client. It stores nothing and parses nothing. Live chat logic lives in `public/app.js`; accounts and saved messages are handled inside `app.bzg`, using packets that are answered to one client instead of being broadcast.

The live chat part is a relay on purpose. An earlier version kept the username list on the server in a BSL array, and it misbehaved (messages were treated as new usernames, and the server stalled when two people joined together). The relay design only uses `sendAll`, which is the same thing the original lab server did.

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
- Pictures are saved on the server, so they survive a refresh and people who join later see them. Only pictures sent while the server was running this version are saved.
- Pictures are compressed, so quality is lower than the original. Transparent PNGs get a white background, and animated GIFs over 160 KB become still.
- If pictures never show up on your server, it may not accept large packets. Lower `CHUNK_CHARS` to 800, then 400.

## Server Handlers (`app.bzg`)

| Handler | Behavior |
| ------- | -------- |
| `server.get` | `/` serves `public/index.html`, `/style.css` and `/app.js` their files, anything else serves `public/404.html` |
| `server.onConnect` | Logs the connection |
| `server.onData` | `SIGNUP`, `LOGIN`, `HISTORY` and `SAVE` are handled by the server and answered to the sender only. Everything else is broadcast to everyone with `sendAll` |
| `server.onDisconnect` | Logs the disconnection |

## Limitations

- Because the server doesn't check anything, a person who edits the page's code could pretend to be someone else. That's fine for a lab or a class demo, but not for real use.
- If someone's browser crashes (no `BYE`), their name stays in the list for up to 2.5 minutes.
- Picture files are not deleted when the 2000-message limit pushes their entry out of `chatlogs.txt`; delete old files in `database/images/` by hand if the folder grows.
- With `PERSIST = false`, accounts and saved chat are lost when the server stops.
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

1. **Start the servers with `start-server.bat`** (double-click it). The first time, right-click it and choose **Run as administrator** so it can open the Windows Firewall for port 8000. After that, a normal double-click is enough.
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
netsh advfirewall firewall add rule name="BISCORD LAN TCP 8000" dir=in action=allow protocol=TCP localport=8000 profile=any
```

To remove the firewall rule later:

```bash
netsh advfirewall firewall delete rule name="BISCORD LAN TCP 8000"
```

When Windows asks whether to let `bonezegei` through the firewall, allow it.

The page picks up the address it was opened from, so no code changes are needed for other devices.

## Sharing over the internet with ngrok

Run `ngrok http 8000`. Everything (page, live chat, accounts) is on that one port, so a single tunnel carries it all. Open the `https://...ngrok...` address ngrok prints.

## Customization

- **Add or rename channels:** edit the `CHANNELS` list near the top of the script in `public/index.html`. Every browser needs the same list. The server doesn't need to change.

- **Change the port:** edit `http(8000)` in `app.bzg`. The client uses the page's own host and port, so it follows automatically.
- **Presence timing:** adjust `HEARTBEAT_MS` and `STALE_MS` at the top of the script in `public/index.html`.
- **Recolor the app:** edit the variables in `:root` in `public/index.html`.

## Troubleshooting

- **Console shows messages but the chat area stays empty:** open the Console and look at the `[Server]` lines. BISCORD messages look like `HELLO|...` or `Alice says: Hello`. If you see a `[System] Ignored a message...` line, the server is running an old `app.bzg`. Replace the one in the project root with the relay version and restart. The page also understands the original lab server's `User <n> says: ...` format, so chat still works with it.

- **`Attempt to call method on non-object type` when the server runs:** `app.bzg` called a method on a string or array (such as `.indexOf`, `.length` or `.push`). BSL has none, see "Editing app.bzg" below. The line number it reports is often the end of the file, not the real spot.
- **`Undefined variable <name>` when the server runs:** a function is called before it is defined. Move it above the code that calls it.
- **`Array index -1 out of bounds`:** an index was used before being checked. `||` and `&&` do not short-circuit in BSL.
- **Works on the PC but not on other devices:** open the page on the PC using your IP address (not `localhost`). If that works but other devices fail, it's the firewall (run the `.bat` as administrator once) or the Wi-Fi. Guest networks and some routers block devices from talking to each other ("client isolation" or "AP isolation").
- **Phone is on mobile data:** turn mobile data off so it uses the same Wi-Fi as the PC.
- **Wrong IP:** VPNs, WSL and VirtualBox add extra addresses. Use the one that starts with `192.168` or `10.`.

- **Status shows Offline:** make sure the server is running. The client retries every 2 seconds.
- **"The server didn't answer" at log in:** the page is open but `app.bzg` isn't answering (or is an older copy without the account packets). Restart it with the current `app.bzg`.
- **"That account is already online":** that login is open in another tab or device. Wait a few minutes if it was a crashed tab.
- **Port already in use:** close the other program or change the port.

## Editing app.bzg: Bonezegei rules learned the hard way

Bonezegei looks like JavaScript but is much smaller. These rules were verified against interpreter v1.3.3:

- **Strings and arrays have no methods.** Use `sizeof(x)` for length, `substr(s, start, len)` for slices, `s[i]` for one character, and `arr[sizeof(arr)] = value` to append. There is no `indexOf`, `split`, `toLowerCase`, `push` or `shift`; `app.bzg` has its own `indexOfChar()` and `lower()` helpers. Arrays cannot shrink.
- **Define functions before using them.** A function can only call functions defined above it in the file.
- **No short-circuit evaluation.** `a || b` and `a && b` evaluate both sides, so guard an index with a separate `if` first.
- **Strings cannot be compared with `<` or `>`**, only `==` and `!=`.
- `null` prints as `0`, `readFile` of a missing file returns an empty string, and `%` is the modulo operator.

## License

MIT