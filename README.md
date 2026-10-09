# Browser SSH

An SSH client that runs entirely in the browser. There is no backend, relay or WebSocket proxy:
the page opens a raw TCP connection to `sshd` with the **Direct Sockets API** and speaks the SSH
protocol itself.

> [!WARNING]
> **Not security-audited.** The SSH protocol code is a new, independent implementation that has
> not had a security review. It is tested against OpenSSH, and all cryptographic primitives come
> from the browser's WebCrypto rather than custom code, but bugs in protocol handling can still
> undermine the security SSH is supposed to provide. Use it for learning and experiments, not to
> protect sensitive servers or credentials. Please report security issues privately rather than
> in public issues.

Everything here is written from scratch with zero runtime dependencies:

- **SSH protocol** (`src/ssh/`)
  - transport (RFC 4253): `curve25519-sha256` key exchange, strict-KEX (Terrapin mitigation) and re-keying
  - user authentication (RFC 4252/4256): Ed25519 public key, password and keyboard-interactive
  - connection layer (RFC 4254): channels, flow control, PTY, `exec`
- **Terminal emulator** (`src/term/`)
  - VT500-style parser
  - xterm-compatible screen model: alternate screen, scroll regions, 16/256/truecolor, wide characters, DEC line drawing
  - canvas renderer
  - keyboard, mouse (SGR and X10 reporting), bracketed paste, selection and scrollback
- **Crypto** comes from the browser's built-in WebCrypto (X25519, Ed25519, ECDSA P-256, AES-GCM, AES-CTR, HMAC-SHA-256). No primitives are hand-rolled.

| Negotiated algorithms | |
|---|---|
| Key exchange | `curve25519-sha256`, `curve25519-sha256@libssh.org` |
| Host keys | `ssh-ed25519`, `ecdsa-sha2-nistp256` |
| Ciphers | `aes256-gcm@openssh.com`, `aes128-gcm@openssh.com`, `aes128-ctr` + `hmac-sha2-256-etm@openssh.com` |

## Why it has to be an Isolated Web App

Web pages cannot open TCP sockets. Chromium exposes `TCPSocket` (Direct Sockets) only to
**Isolated Web Apps (IWAs)**: signed, installed apps with a strict CSP and their own storage.
No browser rebuild is needed. The stock Chromium build includes everything required.

## Running it (Chromium on Linux, macOS, Windows or ChromeOS)

1. In `chrome://flags`, enable **Isolated Web Apps** and **Isolated Web App Developer Mode**,
   then restart.
2. Start the dev server (Node built-ins only):
   ```sh
   npm run dev            # http://localhost:8787  (PORT=… to change)
   ```
3. Open `chrome://web-app-internals`, find **Install IWA via Dev Mode Proxy**, enter
   `http://localhost:8787` and click Install. Launch **Browser SSH** from the app launcher or
   `chrome://apps`.
   - You can also do the install from the command line:
     `chromium --enable-features=IsolatedWebApps,IsolatedWebAppDevMode --install-isolated-web-app-from-url=http://localhost:8787`
4. The first time you connect to a private or loopback address (`192.168.x.x`, `10.x`,
   `127.0.0.1`), Chromium asks for **local network access**. Allow it.

In dev-proxy mode the app loads files from the dev server, so a reload picks up code changes.
Changes to `.well-known/manifest.webmanifest` require reinstalling.

### Usage

- **Host key verification:** trust on first use. The fingerprint is shown in the same
  `SHA256:…` format as `ssh-keygen -lf`. A changed host key refuses the connection; the dialog
  lets you forget the saved key after you have verified the new one.
- **Keys:** pick an **unencrypted OpenSSH Ed25519** private key file. Passphrase-protected and
  RSA keys are not supported yet. The key is read for this connection only and never stored.
- **Password prompts:** if you leave the password empty, the server's password or
  keyboard-interactive prompts (including 2FA codes) appear in a dialog.
- **Keyboard and mouse:**

  | Action | How |
  |---|---|
  | Copy | Select text to copy it, or press Ctrl+Shift+C |
  | Paste | Ctrl+Shift+V |
  | Scroll back | Shift+PageUp/PageDown, or the mouse wheel |
  | Bypass app mouse mode to select text | Hold Shift (for apps like htop or vim with `mouse=a`) |

- **CJK text** needs a CJK font on the system (for example `noto-fonts-cjk` on Arch).

## Running it as a desktop app (Electron)

If you don't want to set up the Isolated Web App, the same front-end runs in a **frameless
Electron window**. There's no title bar, just minimize (–) and close (×) buttons, and you drag
the window by its header.

The window keeps the aspect ratio of the monitor it's on: 16:9 on a 2560×1440 screen, 16:10 on
a 2560×1600 one. It opens at 60% of the screen and holds that shape while you drag its edges
(Electron's `setAspectRatio`). If you move it to a monitor with different proportions, it
switches to that monitor's ratio. Maximize and fullscreen are exempt.

```sh
npm run app        # uses the system electron39 (pacman -S electron39); no npm install needed
```

Electron has no Direct Sockets, so the main process (`electron/main.js`) opens the TCP connection
and passes raw bytes through a sandboxed preload bridge (`electron/preload.cjs`):

- Those bytes are already encrypted. The page still does all the SSH work (key exchange,
  encryption, authentication) and the terminal, so the main process never sees plaintext or
  credentials.
- The page runs with context isolation and a sandbox, so it has no access to Node.
- It is served from a private `app://` scheme with a strict CSP.

## Tests

```sh
npm test                      # unit tests: wire format, ciphers, X25519 vector, parser, screen
node test/integration.mjs --host 127.0.0.1 --port 22 --user "$USER" --key ~/.ssh/id_ed25519
node test/integration.mjs --host 127.0.0.1 --port 22 --user someone --password '…'
```

The integration test runs the same protocol code in Node. Node also implements WebCrypto, and
`test/node-transport.mjs` stands in for Direct Sockets. The test covers:

- authentication
- `exec` with exit codes and stderr
- a PTY shell
- a 4 MB download and a 1 MB upload (window flow control)

Set `RekeyLimit 1M` in `sshd_config` to exercise re-keying as well.

## Layout

```
.well-known/manifest.webmanifest  IWA manifest (permissions policy: direct-sockets, local network access)
index.html, styles.css            UI (no inline scripts; IWA CSP and Trusted Types compatible)
src/main.js                       UI wiring: connect form, host key and auth dialogs
src/transport/direct-socket.js    TCPSocket → { read, write, close }
src/ssh/                          wire, cipher, kex, hostkey, transport, auth, openssh-key, connection, client, known-hosts
src/term/                         parser, screen, wcwidth, renderer, input, terminal
dev/serve.mjs                     dev server with cross-origin isolation headers
test/                             unit and integration tests
```

## Shipping a signed bundle

For distribution without developer mode, build a Signed Web Bundle:

1. Package the public files (`index.html`, `styles.css`, `src/`, `icons/`, `.well-known/`) as a
   Web Bundle.
2. Sign it with an Ed25519 key, using `wbn` + `wbn-sign`. These are dev-only dependencies.

Install the resulting `.swbn` through enterprise policy or `chrome://web-app-internals`. The app
ID is derived from the signing key, so keep that key safe.

## License

[MIT](LICENSE) © 2026 Rodolfo Villaruz
