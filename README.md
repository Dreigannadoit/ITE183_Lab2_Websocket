# Chatterbox – Bonezegei WebSocket Chat (ITE183 Lab 2)

A real-time group chat app. The server is written in **Bonezegei Script Language (`.bzg`)** and serves a cartoon-style browser client with heavy outlines and a semi-3D look.

## Features

- Username screen before chatting (2–16 characters, no `|` or `,`)
- Server-side usernames, with duplicate names rejected
- Join and leave announcements
- Live "Online" list, updated whenever someone joins or leaves
- Chat bubbles with sender name, timestamp and a colored initial avatar
- Auto-reconnect: if the connection drops, the client retries and reclaims its username
- Responsive layout (the online list becomes a slide-in panel on phones)

## Project Structure

```
.
├── app.bzg              # Server: HTTP routes, usernames, WebSocket handlers
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

## Message Protocol

Everything travels as plain text over one WebSocket.

**Client → server**

| Message | Meaning |
| ------- | ------- |
| first message on a connection | the username the client wants |
| any later message | a chat message |

**Server → client**

| Message | Meaning |
| ------- | ------- |
| `OK\|name` | username accepted |
| `ERR\|reason` | username rejected (empty or taken) |
| `SYS\|text` | join/leave notice |
| `MSG\|name\|text` | chat message from `name` |
| `USERS\|a,b,c` | everyone currently online |

The server keeps one array, `names[clientId]`. An empty string means the client has connected but not joined yet.

## Server Handlers (`app.bzg`)

| Handler | Behavior |
| ------- | -------- |
| `server.get` | `/` serves `public/index.html`, anything else serves `public/404.html` |
| `server.onConnect` | Marks the client as not joined |
| `server.onData` | First message: validate and register the username, announce it, send the user list. After that: broadcast `MSG\|name\|text` |
| `server.onDisconnect` | Frees the name, announces the leave, sends the updated user list |

## Design

Palette (defined as CSS variables at the top of `public/index.html`):

| Role | Colors |
| ---- | ------ |
| Primary | Bubble Blue `#2D6BFF`, Sunny Yellow `#FFD23F` |
| Secondary | Mint Green `#35D07F`, Bubblegum Pink `#FF6FA5`, Sky Cyan `#5CCBFF` |
| Complementary | Orange `#FF8A2B` (opposite blue), Purple `#8B5CF6` (opposite yellow) |
| Neutrals | Ink `#1B1230`, Paper `#FFF6DF`, White |

Fonts are Lilita One (headings) and Nunito (text), loaded from Google Fonts. Offline, the page falls back to system rounded fonts.

## Customization

- **Change the port:** edit `http(8000)` in `app.bzg`. The client uses the page's own host and port, so it follows automatically.
- **Raise the user limit:** change `MAX_CLIENTS` (default 64) in `app.bzg`.
- **Recolor the app:** edit the variables in `:root` in `public/index.html`.

## Troubleshooting

- **Status shows Offline:** make sure the server is running. The client retries every 2 seconds.
- **"That username is taken":** another connection is using that exact name (case-sensitive).
- **Port already in use:** close the other program or change the port.

## License

MIT
