# ITE183 Lab 2 – WebSocket Server

A simple HTTP + WebSocket chat server written in **Bonezegei Script Language (`.bzg`)**, with a browser-based test client. Every message a client sends is broadcast to all connected clients.

## Features

- Serves a web page over HTTP on port `8000`
- Accepts WebSocket connections on the same port (`ws://localhost:8000`)
- Sends a welcome message to each client when it connects
- Broadcasts every received message to all connected clients (`User <id> says: <message>`)
- Logs connect, disconnect and message events to the console
- Browser test client with live connection status, message input and message log
- Custom `404` page for any unknown route

## Project Structure

```
.
├── app.bzg              # Main server script (HTTP routes + WebSocket handlers)
├── package.json         # Project metadata and start script
├── lib/
│   ├── http.bzg         # Loads the native http module
│   ├── http.json        # Function/method reference for the http module
│   └── http/
│       └── http.dll     # Native HTTP/WebSocket library
├── public/
│   ├── index.html       # WebSocket test client
│   └── 404.html         # Not-found page
└── README.md
```

## Requirements

- Windows (the native module is a `.dll`)
- The **Bonezegei** interpreter, available on your PATH as `bonezegei`
- A modern web browser

## Getting Started

1. Clone or extract the project and open a terminal in its root folder.
2. Start the server:

   ```bash
   bonezegei app.bzg
   ```

   or, if you use npm:

   ```bash
   npm start
   ```

3. Open <http://localhost:8000> in your browser. The status bar should turn green and show **Connected**.
4. Open the page in a second tab or window, then send a message from one – both will receive it.

## How It Works

### HTTP

| Route | Response |
| ----- | -------- |
| `/`   | `public/index.html` (test client) |
| any other path | `public/404.html` |

### WebSocket Events

| Handler | Triggered when | Behavior |
| ------- | -------------- | -------- |
| `server.onConnect(clientId)` | A client connects | Logs the connection and sends a welcome message to that client |
| `server.onData(message, clientId)` | A client sends a message | Logs it and broadcasts `User <clientId> says: <message>` to everyone |
| `server.onDisconnect(clientId)` | A client disconnects | Logs the disconnection |

## `http` Module API

Provided by `lib/http.bzg` and documented in `lib/http.json`.

| Method | Description |
| ------ | ----------- |
| `http(port)` | Creates a server object listening on `port` |
| `get(path, data)` | HTTP GET callback |
| `post(path, data)` | HTTP POST callback |
| `sendResponse(message, type, code)` | Sends a response (e.g. `"text/html"`, `200`) |
| `sendFile(filename)` | Sends a file to the client |
| `onConnect(clientId)` | WebSocket connect callback |
| `onData(data, clientId)` | WebSocket message callback |
| `onDisconnect(clientId)` | WebSocket disconnect callback |
| `send(clientId, message)` | Sends a message to one client |
| `sendAll(message)` | Sends a message to all clients |
| `run()` | Starts the server loop |

## Customization

- **Change the port:** edit `http(8000)` in `app.bzg` and update `wsUrl` in `public/index.html` to match.
- **Echo instead of broadcast:** in `server.onData`, use `server.send(clientId, "Echo: " + message);` instead of `server.sendAll(...)`.
- **Add a page:** add another `else if(path == "/yourpath")` branch in `server.get` and serve a new file from `public/`.

## Troubleshooting

- **Status stays "Disconnected":** make sure the server is running and the port in `wsUrl` matches the server's port.
- **Port already in use:** close the other program using port `8000`, or change the port as described above.
- **`bonezegei` not recognized:** install the interpreter and add it to your PATH.

## License

MIT