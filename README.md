# Chatterbox – Bonezegei WebSocket Chat (ITE183 Lab 2)

A real-time group chat app. The server is a small relay written in **Bonezegei Script Language (`.bzg`)**. It serves a cartoon-style browser client with heavy outlines and a semi-3D look.

## Features

- Username screen before chatting (2–16 characters, no `|` or `,`)
- Duplicate usernames are rejected (case-insensitive), even if two people join at the same instant
- Join and leave announcements
- Live "Online" list, updated whenever someone joins or leaves
- Chat bubbles with sender name, timestamp and a colored initial avatar
- Auto-reconnect: if the connection drops, the client retries and tells everyone it is back
- Responsive layout (the online list becomes a slide-in panel on phones)

## Project Structure

```
.
├── start-server.bat     # Windows launcher: firewall rule, shows your IP, runs the server
├── app.bzg              # Server: HTTP routes + WebSocket relay
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
- A modern web browser

## Getting Started

```bash
bonezegei app.bzg     # or: npm start
```

Open <http://localhost:8000>, pick a username and start chatting. Open a second tab or device on the same network (use the host machine's IP instead of `localhost`) to chat with yourself.

## How It Works

The server is a **plain relay**: whatever one client sends, it broadcasts to every connected client. It stores nothing and parses nothing. All chat logic lives in `public/index.html`.

This is on purpose. An earlier version kept the username list on the server in a BSL array, and it misbehaved (messages were treated as new usernames, and the server stalled when two people joined together). The relay design only uses `sendAll`, which is the same thing the original lab server did.

### Message format

Every message is plain text shaped like `TYPE|id|name|payload`. Each browser tab has a random `id`.

| Type | Sent when | Meaning |
| ---- | --------- | ------- |
| `CLAIM` | You press Join | "I'd like this username" |
| `TAKEN` | Someone already has that name | Tells the claimer to pick another. If two people claim the same name at once, the lower `id` wins |
| `HELLO` | Your claim wasn't challenged for 0.7 seconds | You joined. Everyone replies with `HERE` so you learn who is online |
| `HERE` | Replying to `HELLO`, and every 20 seconds | "I'm online" |
| `MSG` | You send a message | The payload is the text |
| `BYE` | You close the tab | You left. Clients also drop anyone silent for 2.5 minutes |

## Server Handlers (`app.bzg`)

| Handler | Behavior |
| ------- | -------- |
| `server.get` | `/` serves `public/index.html`, anything else serves `public/404.html` |
| `server.onConnect` | Logs the connection |
| `server.onData` | Logs the message and broadcasts it to everyone with `sendAll` |
| `server.onDisconnect` | Logs the disconnection |

## Limitations

- Because the server doesn't check anything, a person who edits the page's code could pretend to be someone else. That's fine for a lab or a class demo, but not for real use.
- If someone's browser crashes (no `BYE`), their name stays in the list for up to 2.5 minutes.
- You only see messages sent after you joined.

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

1. **Start the server with `start-server.bat`** (double-click it). The first time, right-click it and choose **Run as administrator** so it can open the Windows Firewall for port 8000. After that, a normal double-click is enough.
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

- **Change the port:** edit `http(8000)` in `app.bzg`. The client uses the page's own host and port, so it follows automatically.
- **Presence timing:** adjust `HEARTBEAT_MS` and `STALE_MS` at the top of the script in `public/index.html`.
- **Recolor the app:** edit the variables in `:root` in `public/index.html`.

## Troubleshooting

- **Works on the PC but not on other devices:** open the page on the PC using your IP address (not `localhost`). If that works but other devices fail, it's the firewall (run the `.bat` as administrator once) or the Wi-Fi. Guest networks and some routers block devices from talking to each other ("client isolation" or "AP isolation").
- **Phone is on mobile data:** turn mobile data off so it uses the same Wi-Fi as the PC.
- **Wrong IP:** VPNs, WSL and VirtualBox add extra addresses. Use the one that starts with `192.168` or `10.`.

- **Status shows Offline:** make sure the server is running. The client retries every 2 seconds.
- **"That username is taken":** someone online already uses that name (case doesn't matter). Wait a few minutes if it was a crashed tab.
- **Port already in use:** close the other program or change the port.

## License

MIT