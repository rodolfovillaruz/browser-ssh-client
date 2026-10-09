// Translates keyboard events into the byte sequences an xterm-compatible host expects.

const CSI = '\x1b[';
const SS3 = '\x1bO';

// key → [final, tildeCode]; cursor-style keys use a letter final, editing keys use "CSI n ~".
const SPECIAL = {
  ArrowUp: ['A'],
  ArrowDown: ['B'],
  ArrowRight: ['C'],
  ArrowLeft: ['D'],
  Home: ['H'],
  End: ['F'],
  Insert: [null, 2],
  Delete: [null, 3],
  PageUp: [null, 5],
  PageDown: [null, 6],
  F1: ['P'],
  F2: ['Q'],
  F3: ['R'],
  F4: ['S'],
  F5: [null, 15],
  F6: [null, 17],
  F7: [null, 18],
  F8: [null, 19],
  F9: [null, 20],
  F10: [null, 21],
  F11: [null, 23],
  F12: [null, 24],
};

// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
function modifierParam(e) {
  return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
}

function ctrlChar(key) {
  if (key.length !== 1) return null;
  const c = key.toUpperCase().charCodeAt(0);
  if (c >= 0x40 && c <= 0x5f) return String.fromCharCode(c - 0x40); // @, A-Z, [ \ ] ^ _
  if (key === ' ' || key === '2') return '\x00';
  if (key === '3') return '\x1b';
  if (key === '4') return '\x1c';
  if (key === '5') return '\x1d';
  if (key === '6') return '\x1e';
  if (key === '7' || key === '/' || key === '-') return '\x1f';
  if (key === '8' || key === '?') return '\x7f';
  return null;
}

// Returns the string to send for `e`, or null to let the browser handle it.
export function keyToSequence(e, modes) {
  const mod = modifierParam(e);
  const special = SPECIAL[e.key];

  if (special) {
    const [final, tilde] = special;
    if (tilde) return mod > 1 ? `${CSI}${tilde};${mod}~` : `${CSI}${tilde}~`;
    if (mod > 1) return `${CSI}1;${mod}${final}`;
    const isFKey = e.key.startsWith('F');
    return (modes.appCursor || isFKey ? SS3 : CSI) + final;
  }

  switch (e.key) {
    case 'Enter':
      return e.altKey ? '\x1b\r' : '\r';
    case 'Backspace':
      if (e.ctrlKey) return '\x08';
      return e.altKey ? '\x1b\x7f' : '\x7f';
    case 'Tab':
      return e.shiftKey ? `${CSI}Z` : '\t';
    case 'Escape':
      return '\x1b';
  }

  if (e.key.length !== 1) return null; // Shift, Control, dead keys, media keys, …

  if (e.ctrlKey && !e.altKey) {
    return ctrlChar(e.key);
  }
  if (e.altKey && !e.ctrlKey) {
    // On macOS Option composes characters; elsewhere Alt acts as Meta.
    return '\x1b' + e.key;
  }
  if (e.ctrlKey && e.altKey) {
    // AltGr on many layouts reports Ctrl+Alt; pass the composed character through.
    return e.key;
  }
  return e.key;
}

// Encodes a mouse event for the host. `button`: 0 left, 1 middle, 2 right, 3 release,
// 64/65 wheel up/down; `motion` adds the drag flag.
export function mouseSequence({ button, col, row, release, motion, shift, alt, ctrl }, sgr) {
  let code = button + (motion ? 32 : 0) + (shift ? 4 : 0) + (alt ? 8 : 0) + (ctrl ? 16 : 0);
  if (sgr) return `${CSI}<${code};${col + 1};${row + 1}${release ? 'm' : 'M'}`;
  if (release) code = 3 + (code & ~3);
  if (col > 222 || row > 222) return '';
  return `${CSI}M${String.fromCharCode(32 + code, 33 + col, 33 + row)}`;
}

export function pasteSequence(text, bracketed) {
  const normalized = text.replace(/\r?\n/g, '\r');
  if (!bracketed) return normalized;
  return `${CSI}200~${normalized.replaceAll('\x1b[201~', '')}${CSI}201~`;
}
