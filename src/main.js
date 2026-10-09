import { Terminal } from './term/terminal.js';
import { SshClient, parsePrivateKey } from './ssh/client.js';
import { connectDirect, directSocketsAvailable } from './transport/direct-socket.js';
import { connectElectron, electronSocketsAvailable } from './transport/electron-socket.js';
import { checkHost, rememberHost, forgetHost } from './ssh/known-hosts.js';

const $ = (id) => document.getElementById(id);
const PROFILE_KEY = 'browser-ssh:last-profile';

const form = $('connect-form');
const term = new Terminal($('terminal'));
let session = null; // { client, channel, label }

const dim = (s) => `\x1b[90m${s}\x1b[0m\r\n`;
const red = (s) => `\x1b[31m${s}\x1b[0m\r\n`;

// ---- dialog --------------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// Shows a modal and resolves with { button, values } (button is null if dismissed with Esc).
function ask({ title, warning = false, body = [], fields = [], buttons }) {
  const dialog = $('dialog');
  const heading = $('dialog-title');
  heading.textContent = title;
  heading.className = warning ? 'warning' : '';
  $('dialog-body').replaceChildren(...body);

  const inputs = fields.map((f) => el('input', { type: f.secret ? 'password' : 'text', autocomplete: 'off', spellcheck: false }));
  $('dialog-body').append(
    ...fields.map((f, i) => el('label', { className: 'field' }, el('span', { textContent: f.label }), inputs[i])),
  );
  // Buttons are listed in visual order (primary last). They go into the DOM reversed and are
  // flipped back with CSS, so pressing Enter in a field triggers the primary action rather than
  // the first button.
  $('dialog-buttons').replaceChildren(
    ...buttons
      .map((b) => el('button', { value: b.value, textContent: b.label, className: b.kind ?? '' }))
      .reverse(),
  );

  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        resolve({ button: dialog.returnValue || null, values: inputs.map((i) => i.value) });
        term.focus();
      },
      { once: true },
    );
    dialog.returnValue = '';
    dialog.showModal();
    (inputs[0] ?? dialog.querySelector('button.primary'))?.focus();
  });
}

const p = (text) => el('p', { textContent: text });
const code = (text) => el('code', { textContent: text });

// ---- SSH callbacks -------------------------------------------------------------------------

async function verifyHostKey(host, port, { algorithm, key, fingerprint }) {
  const result = await checkHost(host, port, { algorithm, key });
  if (result.status === 'known') return true;

  const target = port === 22 ? host : `${host}:${port}`;
  if (result.status === 'changed') {
    const { button } = await ask({
      title: 'Host key has changed!',
      warning: true,
      body: [
        p(`The key presented by ${target} does not match the one saved earlier. ` +
          'Someone could be intercepting the connection, or the server was reinstalled.'),
        p('Saved:'),
        code(`${result.entry.algorithm} ${result.entry.fingerprint}`),
        p('Presented now:'),
        code(`${algorithm} ${fingerprint}`),
        p('The connection was refused. If you have verified the new key with the server ' +
          'administrator, forget the saved key and connect again.'),
      ],
      buttons: [
        { label: 'Forget saved key', value: 'forget', kind: 'danger' },
        { label: 'Close', value: 'close', kind: 'primary' },
      ],
    });
    if (button === 'forget') await forgetHost(host, port);
    return false;
  }

  const { button } = await ask({
    title: 'Unknown host',
    body: [
      p(`The authenticity of ${target} can't be established. This is the first time you connect to it.`),
      p('Compare this fingerprint with the server (ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub):'),
      code(`${algorithm} ${fingerprint}`),
    ],
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Trust and connect', value: 'trust', kind: 'primary' },
    ],
  });
  if (button !== 'trust') return false;
  await rememberHost(host, port, { algorithm, key, fingerprint });
  return true;
}

async function promptUser({ name, instruction, prompts }) {
  const { button, values } = await ask({
    title: name || 'Authentication',
    body: instruction ? [p(instruction)] : [],
    fields: prompts.map((q) => ({ label: q.prompt.trim(), secret: !q.echo })),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Continue', value: 'ok', kind: 'primary' },
    ],
  });
  if (button !== 'ok') throw new Error('authentication cancelled');
  return values;
}

// ---- connect / disconnect ------------------------------------------------------------------

function setConnected(label, fingerprint) {
  form.hidden = !!label;
  $('session').hidden = !label;
  $('session-label').textContent = label ?? '';
  $('session-fp').textContent = fingerprint ?? '';
  document.title = label ? `${label} — Browser SSH` : 'Browser SSH';
}

async function connect() {
  const host = $('host').value.trim();
  const port = Number($('port').value) || 22;
  const username = $('user').value.trim();
  const password = $('password').value;
  const keyFile = $('key').files[0];
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ host, port, username }));

  $('connect').disabled = true;
  term.reset();
  term.focus();
  term.write(dim(`Connecting to ${host}:${port} …`));

  let client;
  try {
    const privateKey = keyFile ? await parsePrivateKey(await keyFile.text()) : undefined;
    const socket = await (electronSocketsAvailable() ? connectElectron : connectDirect)(host, port);
    client = await SshClient.connect(socket, {
      username,
      password: password || undefined,
      privateKey,
      prompt: promptUser,
      onBanner: (text) => term.write(text.replace(/\r?\n/g, '\r\n')),
      verifyHostKey: (k) => verifyHostKey(host, port, k),
    });
    term.write(dim(`Authenticated as ${username} (${client.transport.algorithms.cipherC2S}).`));
    const channel = await client.shell({ cols: term.cols, rows: term.rows });
    $('password').value = '';

    const label = `${username}@${host}${port === 22 ? '' : `:${port}`}`;
    session = { client, channel, label };
    setConnected(label, client.hostKeyFingerprint);

    channel.ondata = (data) => term.write(data);
    channel.onexit = (e) => {
      if (e.status !== undefined && e.status !== 0) term.write(dim(`\r\n[exit status ${e.status}]`));
      if (e.signal) term.write(dim(`\r\n[killed by signal ${e.signal}]`));
    };
    channel.onclose = () => endSession('Connection closed.');
    client.onclose = (err) => endSession(err ? `Disconnected: ${err.message}` : 'Disconnected.');
  } catch (err) {
    client?.close();
    term.write(red(err.message));
    console.error(err);
  } finally {
    $('connect').disabled = false;
  }
}

function endSession(message) {
  if (!session) return;
  const { client } = session;
  session = null;
  client.close().catch(() => {});
  term.write(dim(`\r\n${message}`));
  setConnected(null);
  $('password').focus();
}

// ---- wiring --------------------------------------------------------------------------------

term.onData((data) => session?.channel.write(data).catch(() => {}));
term.onResize(({ cols, rows }) => session?.channel.resize(cols, rows).catch(() => {}));
term.onTitle((title) => {
  if (session) document.title = title || session.label;
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  connect();
});
$('disconnect').addEventListener('click', () => endSession('Disconnected.'));

// ---- window chrome -------------------------------------------------------------------------

// In the Electron shell the window is frameless; these buttons are its only window controls.
if (window.electronWindow) document.documentElement.classList.add('frameless');

$('minimize-window').addEventListener('click', () => window.electronWindow?.minimize());

$('close-window').addEventListener('click', () => {
  endSession('Disconnected.');
  if (window.electronWindow) window.electronWindow.close();
  else window.close();
});

// Borderless display mode only takes effect once the window-management permission is granted.
// Ask on the first click (permission prompts need a user gesture); the window switches to
// borderless the next time the app is opened.
async function requestBorderless() {
  if (window.electronWindow) return;
  if (matchMedia('(display-mode: borderless)').matches || !('getScreenDetails' in window)) return;
  try {
    const status = await navigator.permissions.query({ name: 'window-management' });
    if (status.state === 'prompt') await window.getScreenDetails();
  } catch {
    // Not supported or denied: the window keeps the overlay / standalone title bar.
  }
}
document.addEventListener('pointerdown', requestBorderless, { once: true });

try {
  const last = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
  if (last) {
    $('host').value = last.host ?? '';
    $('port').value = last.port ?? 22;
    $('user').value = last.username ?? '';
  }
} catch {
  // ignore unreadable profile
}

term.write('\x1b[1mBrowser SSH\x1b[0m — the SSH protocol and this terminal run entirely in this page.\r\n');
if (!directSocketsAvailable() && !electronSocketsAvailable()) {
  term.write(red('\r\nDirect Sockets API not available.'));
  term.write(dim('This page must run as an Isolated Web App in Chromium:'));
  term.write(dim('  1. chrome://flags → enable "Isolated Web Apps" and "Isolated Web App Developer Mode"'));
  term.write(dim('  2. chrome://web-app-internals → "Install IWA via Dev Mode Proxy" → http://localhost:8787'));
}
($('host').value ? $('password') : $('host')).focus();
