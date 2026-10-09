// Terminal screen model: cell grid, cursor, modes and the xterm control functions that act on them.
// It knows nothing about bytes or rendering; parser.js calls into it, renderer.js reads from it.

import { wcwidth } from './wcwidth.js';

// Colors: -1 = default, 0..255 = palette index, >= RGB_FLAG = truecolor (RGB_FLAG | 0xRRGGBB).
export const DEFAULT_COLOR = -1;
export const RGB_FLAG = 0x1000000;

export const ATTR = {
  BOLD: 1,
  DIM: 2,
  ITALIC: 4,
  UNDERLINE: 8,
  BLINK: 16,
  INVERSE: 32,
  HIDDEN: 64,
  STRIKE: 128,
};

// DEC Special Graphics (ESC ( 0), used by curses for line drawing.
const DEC_GRAPHICS = {
  '`': '◆', a: '▒', b: '␉', c: '␌', d: '␍', e: '␊', f: '°', g: '±', h: '␤', i: '␋', j: '┘',
  k: '┐', l: '┌', m: '└', n: '┼', o: '⎺', p: '⎻', q: '─', r: '⎼', s: '⎽', t: '├', u: '┤',
  v: '┴', w: '┬', x: '│', y: '≤', z: '≥', '{': 'π', '|': '≠', '}': '£', '~': '·',
};

// A wide character occupies two cells; the second holds this placeholder.
export const WIDE_TAIL = '';

export class Line {
  constructor(cols, bg = DEFAULT_COLOR) {
    this.chars = new Array(cols).fill(' ');
    this.fg = new Int32Array(cols).fill(DEFAULT_COLOR);
    this.bg = new Int32Array(cols).fill(bg);
    this.attrs = new Uint16Array(cols);
    this.wrapped = false;
  }

  get cols() {
    return this.chars.length;
  }

  clear(from, to, bg) {
    to = Math.min(to, this.cols);
    for (let i = from; i < to; i++) {
      this.chars[i] = ' ';
      this.fg[i] = DEFAULT_COLOR;
      this.bg[i] = bg;
      this.attrs[i] = 0;
    }
  }

  copyCell(to, from) {
    this.chars[to] = this.chars[from];
    this.fg[to] = this.fg[from];
    this.bg[to] = this.bg[from];
    this.attrs[to] = this.attrs[from];
  }

  resize(cols) {
    const old = this.cols;
    if (cols === old) return;
    const next = new Line(cols);
    const n = Math.min(cols, old);
    for (let i = 0; i < n; i++) {
      next.chars[i] = this.chars[i];
      next.fg[i] = this.fg[i];
      next.bg[i] = this.bg[i];
      next.attrs[i] = this.attrs[i];
    }
    // Don't leave half of a wide character at the new right edge.
    if (n > 0 && wcwidthOf(next.chars[n - 1]) === 2) next.chars[n - 1] = ' ';
    Object.assign(this, { chars: next.chars, fg: next.fg, bg: next.bg, attrs: next.attrs });
  }

  text(from = 0, to = this.cols) {
    let s = '';
    for (let i = from; i < Math.min(to, this.cols); i++) s += this.chars[i];
    return s;
  }
}

function wcwidthOf(ch) {
  return ch ? wcwidth(ch.codePointAt(0)) : 1;
}

function blankLines(rows, cols) {
  return Array.from({ length: rows }, () => new Line(cols));
}

export class Screen {
  constructor(cols = 80, rows = 24, { scrollback = 5000 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.scrollbackLimit = scrollback;
    this.onResponse = null; // (string) => void — replies to the host (DA, DSR …)
    this.onBell = null;
    this.onTitle = null;
    this.reset();
  }

  reset() {
    this.primary = blankLines(this.rows, this.cols);
    this.alternate = null;
    this.lines = this.primary;
    this.scrollback = [];
    this.scrolledOff = 0; // total lines pushed to scrollback; lets the view stay put while scrolled
    this.cursor = { x: 0, y: 0 };
    this.pendingWrap = false;
    this.pen = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 };
    this.charsets = ['B', 'B'];
    this.activeCharset = 0;
    this.saved = null;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.tabStops = this.#defaultTabStops();
    this.modes = {
      insert: false,
      autowrap: true,
      origin: false,
      appCursor: false,
      appKeypad: false,
      bracketedPaste: false,
      cursorVisible: true,
      reverseVideo: false,
      mouse: 0, // 0 off, 1000 clicks, 1002 drag, 1003 any motion
      mouseSgr: false,
      focusEvents: false,
    };
    this.cursorStyle = 'block';
    this.title = '';
    this.markAllDirty();
  }

  get isAlternate() {
    return this.lines !== this.primary;
  }

  // ---- dirty tracking -----------------------------------------------------------------------

  markAllDirty() {
    this.dirty = new Uint8Array(this.rows).fill(1);
    this.allDirty = true;
  }

  #touch(y) {
    this.dirty[y] = 1;
  }

  #touchRange(from, to) {
    for (let y = Math.max(0, from); y <= Math.min(to, this.rows - 1); y++) this.dirty[y] = 1;
  }

  takeDirty() {
    const d = this.dirty;
    this.dirty = new Uint8Array(this.rows);
    this.allDirty = false;
    return d;
  }

  // ---- printing -----------------------------------------------------------------------------

  print(text) {
    const graphics = this.charsets[this.activeCharset] === '0';
    for (const raw of text) {
      const ch = graphics ? DEC_GRAPHICS[raw] ?? raw : raw;
      const width = wcwidth(ch.codePointAt(0));
      if (width === 0) {
        this.#combine(ch);
        continue;
      }
      this.#putChar(ch, width);
    }
  }

  #combine(mark) {
    let x = this.pendingWrap ? this.cursor.x : this.cursor.x - 1;
    if (x < 0) return;
    const line = this.lines[this.cursor.y];
    if (line.chars[x] === WIDE_TAIL && x > 0) x--;
    line.chars[x] += mark;
    this.#touch(this.cursor.y);
  }

  #putChar(ch, width) {
    if (this.pendingWrap) {
      if (this.modes.autowrap) {
        this.lines[this.cursor.y].wrapped = true;
        this.cursor.x = 0;
        this.index();
      }
      this.pendingWrap = false;
    }

    if (width === 2 && this.cursor.x === this.cols - 1) {
      if (!this.modes.autowrap) return;
      this.lines[this.cursor.y].clear(this.cursor.x, this.cols, this.pen.bg);
      this.lines[this.cursor.y].wrapped = true;
      this.cursor.x = 0;
      this.index();
    }

    const { x, y } = this.cursor;
    const line = this.lines[y];
    if (this.modes.insert) this.#shiftRight(line, x, width);
    this.#breakWide(line, x);
    if (width === 2) this.#breakWide(line, x + 1);

    this.#setCell(line, x, ch);
    if (width === 2) this.#setCell(line, x + 1, WIDE_TAIL);
    this.#touch(y);

    const next = x + width;
    if (next >= this.cols) {
      this.cursor.x = this.cols - 1;
      this.pendingWrap = this.modes.autowrap;
    } else {
      this.cursor.x = next;
    }
  }

  #setCell(line, x, ch) {
    line.chars[x] = ch;
    line.fg[x] = this.pen.fg;
    line.bg[x] = this.pen.bg;
    line.attrs[x] = this.pen.attrs;
  }

  // Overwriting either half of a wide character erases the other half.
  #breakWide(line, x) {
    if (x >= this.cols) return;
    if (line.chars[x] === WIDE_TAIL && x > 0) line.chars[x - 1] = ' ';
    if (x + 1 < this.cols && line.chars[x + 1] === WIDE_TAIL) line.chars[x + 1] = ' ';
  }

  #shiftRight(line, x, n) {
    for (let i = this.cols - 1; i >= x + n; i--) line.copyCell(i, i - n);
    line.clear(x, x + n, this.pen.bg);
  }

  // ---- C0 controls --------------------------------------------------------------------------

  execute(code) {
    switch (code) {
      case 0x07:
        this.onBell?.();
        break;
      case 0x08:
        if (this.pendingWrap) this.pendingWrap = false;
        else if (this.cursor.x > 0) this.cursor.x--;
        break;
      case 0x09:
        this.#tab(1);
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.index();
        break;
      case 0x0d:
        this.cursor.x = 0;
        this.pendingWrap = false;
        break;
      case 0x0e:
        this.activeCharset = 1;
        break;
      case 0x0f:
        this.activeCharset = 0;
        break;
    }
  }

  // ---- scrolling ----------------------------------------------------------------------------

  index() {
    this.pendingWrap = false;
    if (this.cursor.y === this.scrollBottom) this.scrollUp(1);
    else if (this.cursor.y < this.rows - 1) this.cursor.y++;
  }

  reverseIndex() {
    this.pendingWrap = false;
    if (this.cursor.y === this.scrollTop) this.scrollDown(1);
    else if (this.cursor.y > 0) this.cursor.y--;
  }

  scrollUp(n, top = this.scrollTop, bottom = this.scrollBottom) {
    n = Math.min(n, bottom - top + 1);
    const removed = this.lines.splice(top, n);
    if (top === 0 && !this.isAlternate) {
      this.scrollback.push(...removed);
      this.scrolledOff += removed.length;
      const excess = this.scrollback.length - this.scrollbackLimit;
      if (excess > 0) this.scrollback.splice(0, excess);
    }
    const fresh = Array.from({ length: n }, () => new Line(this.cols, this.pen.bg));
    this.lines.splice(bottom - n + 1, 0, ...fresh);
    this.#touchRange(top, bottom);
  }

  scrollDown(n, top = this.scrollTop, bottom = this.scrollBottom) {
    n = Math.min(n, bottom - top + 1);
    this.lines.splice(bottom - n + 1, n);
    const fresh = Array.from({ length: n }, () => new Line(this.cols, this.pen.bg));
    this.lines.splice(top, 0, ...fresh);
    this.#touchRange(top, bottom);
  }

  // ---- cursor -------------------------------------------------------------------------------

  #moveTo(x, y) {
    this.pendingWrap = false;
    this.cursor.x = Math.max(0, Math.min(this.cols - 1, x));
    const [minY, maxY] = this.modes.origin ? [this.scrollTop, this.scrollBottom] : [0, this.rows - 1];
    this.cursor.y = Math.max(minY, Math.min(maxY, y));
  }

  // Relative vertical moves stop at the scroll margins when starting inside them.
  #moveVertical(dy) {
    const { y } = this.cursor;
    const inside = y >= this.scrollTop && y <= this.scrollBottom;
    const min = inside ? this.scrollTop : 0;
    const max = inside ? this.scrollBottom : this.rows - 1;
    this.pendingWrap = false;
    this.cursor.y = Math.max(min, Math.min(max, y + dy));
  }

  #tab(n) {
    this.pendingWrap = false;
    let x = this.cursor.x;
    while (n > 0 && x < this.cols - 1) {
      x++;
      if (this.tabStops.has(x)) n--;
    }
    while (n < 0 && x > 0) {
      x--;
      if (this.tabStops.has(x)) n++;
    }
    this.cursor.x = x;
  }

  #defaultTabStops() {
    const stops = new Set();
    for (let x = 8; x < this.cols; x += 8) stops.add(x);
    return stops;
  }

  saveCursor() {
    this.saved = {
      x: this.cursor.x,
      y: this.cursor.y,
      pendingWrap: this.pendingWrap,
      pen: { ...this.pen },
      origin: this.modes.origin,
      autowrap: this.modes.autowrap,
      charsets: [...this.charsets],
      activeCharset: this.activeCharset,
    };
  }

  restoreCursor() {
    const s = this.saved;
    if (!s) {
      this.#moveTo(0, 0);
      return;
    }
    this.cursor.x = Math.min(s.x, this.cols - 1);
    this.cursor.y = Math.min(s.y, this.rows - 1);
    this.pendingWrap = s.pendingWrap;
    this.pen = { ...s.pen };
    this.modes.origin = s.origin;
    this.modes.autowrap = s.autowrap;
    this.charsets = [...s.charsets];
    this.activeCharset = s.activeCharset;
  }

  // ---- erasing and editing ------------------------------------------------------------------

  #eraseInDisplay(mode) {
    const { x, y } = this.cursor;
    const bg = this.pen.bg;
    if (mode === 0) {
      this.lines[y].clear(x, this.cols, bg);
      for (let i = y + 1; i < this.rows; i++) this.lines[i] = new Line(this.cols, bg);
      this.#touchRange(y, this.rows - 1);
    } else if (mode === 1) {
      for (let i = 0; i < y; i++) this.lines[i] = new Line(this.cols, bg);
      this.lines[y].clear(0, x + 1, bg);
      this.#touchRange(0, y);
    } else if (mode === 2) {
      for (let i = 0; i < this.rows; i++) this.lines[i] = new Line(this.cols, bg);
      this.markAllDirty();
    } else if (mode === 3) {
      this.scrollback = [];
      this.markAllDirty();
    }
    this.pendingWrap = false;
  }

  #eraseInLine(mode) {
    const { x, y } = this.cursor;
    const line = this.lines[y];
    if (mode === 0) line.clear(x, this.cols, this.pen.bg);
    else if (mode === 1) line.clear(0, x + 1, this.pen.bg);
    else if (mode === 2) line.clear(0, this.cols, this.pen.bg);
    if (mode === 0 || mode === 2) line.wrapped = false;
    this.pendingWrap = false;
    this.#touch(y);
  }

  #insertLines(n) {
    const { y } = this.cursor;
    if (y < this.scrollTop || y > this.scrollBottom) return;
    this.scrollDown(n, y, this.scrollBottom);
    this.cursor.x = 0;
    this.pendingWrap = false;
  }

  #deleteLines(n) {
    const { y } = this.cursor;
    if (y < this.scrollTop || y > this.scrollBottom) return;
    // Lines deleted from the middle of the screen never go to scrollback.
    n = Math.min(n, this.scrollBottom - y + 1);
    this.lines.splice(y, n);
    const fresh = Array.from({ length: n }, () => new Line(this.cols, this.pen.bg));
    this.lines.splice(this.scrollBottom - n + 1, 0, ...fresh);
    this.#touchRange(y, this.scrollBottom);
    this.cursor.x = 0;
    this.pendingWrap = false;
  }

  #insertChars(n) {
    const { x, y } = this.cursor;
    this.#shiftRight(this.lines[y], x, Math.min(n, this.cols - x));
    this.pendingWrap = false;
    this.#touch(y);
  }

  #deleteChars(n) {
    const { x, y } = this.cursor;
    const line = this.lines[y];
    n = Math.min(n, this.cols - x);
    for (let i = x; i < this.cols - n; i++) line.copyCell(i, i + n);
    line.clear(this.cols - n, this.cols, this.pen.bg);
    this.pendingWrap = false;
    this.#touch(y);
  }

  #eraseChars(n) {
    const { x, y } = this.cursor;
    this.lines[y].clear(x, x + n, this.pen.bg);
    this.pendingWrap = false;
    this.#touch(y);
  }

  #repeat(n) {
    const { x, y } = this.cursor;
    const prevX = this.pendingWrap ? x : x - 1;
    if (prevX < 0) return;
    const ch = this.lines[y].chars[prevX];
    if (!ch || ch === WIDE_TAIL) return;
    this.print(ch.repeat(Math.min(n, this.cols * this.rows)));
  }

  // ---- buffers ------------------------------------------------------------------------------

  #enterAlternate(clear) {
    if (this.isAlternate) return;
    if (!this.alternate || clear) this.alternate = blankLines(this.rows, this.cols);
    this.lines = this.alternate;
    this.markAllDirty();
  }

  #leaveAlternate() {
    if (!this.isAlternate) return;
    this.lines = this.primary;
    this.markAllDirty();
  }

  // ---- CSI / ESC / OSC dispatch -------------------------------------------------------------

  // params: array of arrays ([value, ...subparams]); missing values are undefined.
  csi(prefix, params, intermediates, final) {
    const p = (i, def = 1) => params[i]?.[0] || def;
    const p0 = (i) => params[i]?.[0] ?? 0;

    if (intermediates) {
      if (intermediates === ' ' && final === 'q') this.#cursorStyle(p0(0));
      else if (intermediates === '!' && final === 'p') this.#softReset();
      return;
    }

    if (prefix === '?') {
      if (final === 'h' || final === 'l') {
        for (const param of params) this.#decMode(param?.[0] ?? 0, final === 'h');
      }
      return;
    }
    if (prefix === '>') {
      if (final === 'c') this.onResponse?.('\x1b[>0;276;0c');
      return;
    }
    if (prefix) return;

    const { x, y } = this.cursor;
    switch (final) {
      case '@': this.#insertChars(p(0)); break;
      case 'A': this.#moveVertical(-p(0)); break;
      case 'B': case 'e': this.#moveVertical(p(0)); break;
      case 'C': case 'a': this.pendingWrap = false; this.cursor.x = Math.min(this.cols - 1, x + p(0)); break;
      case 'D': this.pendingWrap = false; this.cursor.x = Math.max(0, x - p(0)); break;
      case 'E': this.#moveVertical(p(0)); this.cursor.x = 0; break;
      case 'F': this.#moveVertical(-p(0)); this.cursor.x = 0; break;
      case 'G': case '`': this.#moveTo(p(0) - 1, y); break;
      case 'H': case 'f': {
        const top = this.modes.origin ? this.scrollTop : 0;
        this.#moveTo(p(1) - 1, top + p(0) - 1);
        break;
      }
      case 'I': this.#tab(p(0)); break;
      case 'J': this.#eraseInDisplay(p0(0)); break;
      case 'K': this.#eraseInLine(p0(0)); break;
      case 'L': this.#insertLines(p(0)); break;
      case 'M': this.#deleteLines(p(0)); break;
      case 'P': this.#deleteChars(p(0)); break;
      case 'S': this.scrollUp(p(0)); break;
      case 'T': if (params.length <= 1) this.scrollDown(p(0)); break;
      case 'X': this.#eraseChars(p(0)); break;
      case 'Z': this.#tab(-p(0)); break;
      case 'b': this.#repeat(p(0)); break;
      case 'c': if (p0(0) === 0) this.onResponse?.('\x1b[?62;22c'); break;
      case 'd': {
        const top = this.modes.origin ? this.scrollTop : 0;
        this.#moveTo(x, top + p(0) - 1);
        break;
      }
      case 'g':
        if (p0(0) === 0) this.tabStops.delete(x);
        else if (p0(0) === 3) this.tabStops.clear();
        break;
      case 'h': case 'l':
        for (const param of params) if (param?.[0] === 4) this.modes.insert = final === 'h';
        break;
      case 'm': this.#sgr(params); break;
      case 'n':
        if (p0(0) === 5) this.onResponse?.('\x1b[0n');
        else if (p0(0) === 6) {
          const row = this.modes.origin ? y - this.scrollTop : y;
          this.onResponse?.(`\x1b[${row + 1};${x + 1}R`);
        }
        break;
      case 'r': {
        const top = p(0) - 1;
        const bottom = Math.min(p(1, this.rows), this.rows) - 1;
        if (top < bottom) {
          this.scrollTop = top;
          this.scrollBottom = bottom;
          this.#moveTo(0, this.modes.origin ? top : 0);
        }
        break;
      }
      case 's': this.saveCursor(); break;
      case 'u': this.restoreCursor(); break;
    }
  }

  #decMode(mode, on) {
    const m = this.modes;
    switch (mode) {
      case 1: m.appCursor = on; break;
      case 5: m.reverseVideo = on; this.markAllDirty(); break;
      case 6: m.origin = on; this.#moveTo(0, on ? this.scrollTop : 0); break;
      case 7: m.autowrap = on; if (!on) this.pendingWrap = false; break;
      case 25: m.cursorVisible = on; break;
      case 47: case 1047:
        if (on) this.#enterAlternate(false);
        else this.#leaveAlternate();
        break;
      case 1048: if (on) this.saveCursor(); else this.restoreCursor(); break;
      case 1049:
        if (on) {
          this.saveCursor();
          this.#enterAlternate(true);
        } else {
          this.#leaveAlternate();
          this.restoreCursor();
        }
        break;
      case 1000: case 1002: case 1003: m.mouse = on ? mode : 0; break;
      case 1004: m.focusEvents = on; break;
      case 1006: m.mouseSgr = on; break;
      case 2004: m.bracketedPaste = on; break;
    }
  }

  #cursorStyle(n) {
    this.cursorStyle = n <= 2 ? 'block' : n <= 4 ? 'underline' : 'bar';
  }

  #softReset() {
    Object.assign(this.modes, { insert: false, origin: false, autowrap: true, appCursor: false, appKeypad: false, cursorVisible: true });
    this.pen = { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 };
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.charsets = ['B', 'B'];
    this.activeCharset = 0;
    this.saved = null;
  }

  #sgr(params) {
    if (params.length === 0) params = [[0]];
    const pen = this.pen;
    for (let i = 0; i < params.length; i++) {
      const [code = 0, ...subs] = params[i] ?? [];
      switch (true) {
        case code === 0: pen.fg = DEFAULT_COLOR; pen.bg = DEFAULT_COLOR; pen.attrs = 0; break;
        case code === 1: pen.attrs |= ATTR.BOLD; break;
        case code === 2: pen.attrs |= ATTR.DIM; break;
        case code === 3: pen.attrs |= ATTR.ITALIC; break;
        case code === 4:
          if (subs[0] === 0) pen.attrs &= ~ATTR.UNDERLINE;
          else pen.attrs |= ATTR.UNDERLINE;
          break;
        case code === 5 || code === 6: pen.attrs |= ATTR.BLINK; break;
        case code === 7: pen.attrs |= ATTR.INVERSE; break;
        case code === 8: pen.attrs |= ATTR.HIDDEN; break;
        case code === 9: pen.attrs |= ATTR.STRIKE; break;
        case code === 21: pen.attrs |= ATTR.UNDERLINE; break;
        case code === 22: pen.attrs &= ~(ATTR.BOLD | ATTR.DIM); break;
        case code === 23: pen.attrs &= ~ATTR.ITALIC; break;
        case code === 24: pen.attrs &= ~ATTR.UNDERLINE; break;
        case code === 25: pen.attrs &= ~ATTR.BLINK; break;
        case code === 27: pen.attrs &= ~ATTR.INVERSE; break;
        case code === 28: pen.attrs &= ~ATTR.HIDDEN; break;
        case code === 29: pen.attrs &= ~ATTR.STRIKE; break;
        case code >= 30 && code <= 37: pen.fg = code - 30; break;
        case code === 39: pen.fg = DEFAULT_COLOR; break;
        case code >= 40 && code <= 47: pen.bg = code - 40; break;
        case code === 49: pen.bg = DEFAULT_COLOR; break;
        case code >= 90 && code <= 97: pen.fg = code - 90 + 8; break;
        case code >= 100 && code <= 107: pen.bg = code - 100 + 8; break;
        case code === 38 || code === 48 || code === 58: {
          // Extended color, either colon form (38:2::r:g:b / 38:5:n) or semicolon form (38;2;r;g;b).
          let spec;
          if (subs.length) {
            // 38:2:<colorspace>:r:g:b has an extra (usually empty) colorspace field.
            spec = subs[0] === 2 && subs.length >= 5 ? [2, subs[2], subs[3], subs[4]] : subs;
          } else {
            const kind = params[i + 1]?.[0];
            const n = kind === 2 ? 4 : kind === 5 ? 2 : 1;
            spec = params.slice(i + 1, i + 1 + n).map((q) => q?.[0] ?? 0);
            i += n;
          }
          let color = null;
          if (spec[0] === 5 && spec.length >= 2) color = spec[1] & 0xff;
          else if (spec[0] === 2 && spec.length >= 4) {
            color = RGB_FLAG | ((spec[1] & 0xff) << 16) | ((spec[2] & 0xff) << 8) | (spec[3] & 0xff);
          }
          if (color !== null && code === 38) pen.fg = color;
          else if (color !== null && code === 48) pen.bg = color;
          break;
        }
      }
    }
  }

  esc(intermediates, final) {
    if (intermediates === '(' || intermediates === ')') {
      this.charsets[intermediates === '(' ? 0 : 1] = final === '0' ? '0' : 'B';
      return;
    }
    if (intermediates === '#' && final === '8') {
      for (const line of this.lines) {
        line.clear(0, this.cols, DEFAULT_COLOR);
        line.chars.fill('E');
      }
      this.markAllDirty();
      return;
    }
    if (intermediates) return;
    switch (final) {
      case '7': this.saveCursor(); break;
      case '8': this.restoreCursor(); break;
      case 'D': this.index(); break;
      case 'E': this.cursor.x = 0; this.index(); break;
      case 'H': this.tabStops.add(this.cursor.x); break;
      case 'M': this.reverseIndex(); break;
      case 'c': this.reset(); break;
      case '=': this.modes.appKeypad = true; break;
      case '>': this.modes.appKeypad = false; break;
    }
  }

  osc(data) {
    const sep = data.indexOf(';');
    const code = sep === -1 ? data : data.slice(0, sep);
    if (code === '0' || code === '2') {
      this.title = data.slice(sep + 1);
      this.onTitle?.(this.title);
    }
  }

  // ---- resize -------------------------------------------------------------------------------

  resize(cols, rows) {
    if (cols === this.cols && rows === this.rows) return;
    const resizeBuffer = (lines, keepCursor) => {
      for (const line of lines) line.resize(cols);
      if (rows < lines.length) {
        // Drop lines from the top (into scrollback for the primary buffer) so the cursor stays visible.
        const overflow = lines.length - rows;
        const fromTop = keepCursor ? Math.min(overflow, Math.max(0, this.cursor.y - rows + 1)) : 0;
        const removed = lines.splice(0, fromTop);
        if (lines === this.primary) this.scrollback.push(...removed);
        lines.splice(rows);
        return fromTop;
      }
      while (lines.length < rows) lines.push(new Line(cols));
      return 0;
    };

    const active = this.lines;
    const shift = resizeBuffer(active, true);
    if (active === this.primary) {
      if (this.alternate) resizeBuffer(this.alternate, false);
    } else {
      resizeBuffer(this.primary, false);
    }
    this.cols = cols;
    this.rows = rows;
    this.cursor.y = Math.max(0, Math.min(rows - 1, this.cursor.y - shift));
    this.cursor.x = Math.min(this.cursor.x, cols - 1);
    if (this.saved) {
      this.saved.x = Math.min(this.saved.x, cols - 1);
      this.saved.y = Math.min(this.saved.y, rows - 1);
    }
    this.pendingWrap = false;
    this.scrollTop = 0;
    this.scrollBottom = rows - 1;
    this.tabStops = this.#defaultTabStops();
    this.markAllDirty();
  }

  // Plain-text snapshot of the visible screen (for tests and debugging).
  toString() {
    return this.lines.map((l) => l.text().replaceAll(WIDE_TAIL, '').trimEnd()).join('\n').trimEnd();
  }
}
