// Terminal widget: owns the DOM (canvas + hidden textarea for keyboard/IME/paste) and ties
// Screen, Parser and Renderer together.

import { Screen, WIDE_TAIL } from './screen.js';
import { Parser } from './parser.js';
import { Renderer } from './renderer.js';
import { keyToSequence, mouseSequence, pasteSequence } from './input.js';

const WORD_CHARS = /[\p{L}\p{N}_\-.\/~:@%+]/u;

export class Terminal {
  #dataListeners = [];
  #resizeListeners = [];
  #titleListeners = [];
  #decoder = new TextDecoder('utf-8');
  #frame = 0;
  #offset = 0; // lines scrolled back from the live view
  #lastScrolledOff = 0;
  #lastCursor = { x: 0, y: 0 };
  #selection = null; // { anchor, head } in absolute rows (scrollback + screen)
  #selecting = false;
  #focused = false;
  #mouseDown = -1;
  #composing = false;

  constructor(container, options = {}) {
    this.container = container;
    container.classList.add('term');

    this.canvas = document.createElement('canvas');
    this.input = document.createElement('textarea');
    this.input.className = 'term-input';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('autocorrect', 'off');
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Terminal input');
    container.append(this.canvas, this.input);

    this.screen = new Screen(80, 24, { scrollback: options.scrollback ?? 5000 });
    this.parser = new Parser(this.screen);
    this.renderer = new Renderer(this.canvas, options);
    this.screen.onResponse = (s) => this.#emit(s);
    this.screen.onTitle = (t) => this.#titleListeners.forEach((fn) => fn(t));
    this.screen.onBell = () => this.#bell();

    this.#bindKeyboard();
    this.#bindMouse();
    new ResizeObserver(() => this.fit()).observe(container);
    document.fonts?.ready.then(() => {
      this.renderer.measure();
      this.fit(true);
    });
    this.fit(true);
  }

  get cols() {
    return this.screen.cols;
  }

  get rows() {
    return this.screen.rows;
  }

  onData(fn) {
    this.#dataListeners.push(fn);
  }

  onResize(fn) {
    this.#resizeListeners.push(fn);
  }

  onTitle(fn) {
    this.#titleListeners.push(fn);
  }

  focus() {
    this.input.focus({ preventScroll: true });
  }

  // Accepts raw bytes from the host (UTF-8) or already-decoded text.
  write(data) {
    const text = typeof data === 'string' ? data : this.#decoder.decode(data, { stream: true });
    this.parser.write(text);
    // Keep the scrolled-back view anchored while new output pushes lines into scrollback.
    const added = this.screen.scrolledOff - this.#lastScrolledOff;
    this.#lastScrolledOff = this.screen.scrolledOff;
    if (this.#offset > 0 && added > 0) {
      this.#offset = Math.min(this.#offset + added, this.screen.scrollback.length);
    }
    this.#schedule();
  }

  reset() {
    this.screen.reset();
    this.#offset = 0;
    this.#selection = null;
    this.#schedule(true);
  }

  fit(force = false) {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const { cols, rows } = this.renderer.resize(rect.width, rect.height);
    if (force || cols !== this.screen.cols || rows !== this.screen.rows) {
      this.screen.resize(cols, rows);
      this.#offset = Math.min(this.#offset, this.screen.scrollback.length);
      this.#resizeListeners.forEach((fn) => fn({ cols, rows }));
    }
    this.#schedule(true);
  }

  #emit(data) {
    for (const fn of this.#dataListeners) fn(data);
  }

  // Input typed by the user: snaps the view back to live output.
  #userInput(data) {
    if (!data) return;
    if (this.#offset !== 0 || this.#selection) {
      this.#offset = 0;
      this.#selection = null;
      this.#schedule(true);
    }
    this.#emit(data);
  }

  #schedule(full = false) {
    if (full) this.screen.markAllDirty();
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#draw();
    });
  }

  #draw() {
    const screen = this.screen;
    const { x, y } = screen.cursor;
    // The old and new cursor rows must be repainted even when their text did not change.
    if (this.#lastCursor.y < screen.rows) screen.dirty[this.#lastCursor.y] = 1;
    screen.dirty[y] = 1;
    this.#lastCursor = { x, y };

    const full = screen.allDirty || this.#offset > 0 || this.#selection;
    const dirty = screen.takeDirty();
    this.renderer.render({
      screen,
      offset: this.#offset,
      selection: this.#orderedSelection(),
      focused: this.#focused,
      dirtyRows: full ? null : dirty,
    });
  }

  #bell() {
    this.container.classList.remove('term-bell');
    void this.container.offsetWidth;
    this.container.classList.add('term-bell');
  }

  // ---- keyboard -----------------------------------------------------------------------------

  #bindKeyboard() {
    const input = this.input;
    this.container.addEventListener('mousedown', () => setTimeout(() => this.focus()));

    input.addEventListener('focus', () => {
      this.#focused = true;
      if (this.screen.modes.focusEvents) this.#emit('\x1b[I');
      this.#schedule();
    });
    input.addEventListener('blur', () => {
      this.#focused = false;
      if (this.screen.modes.focusEvents) this.#emit('\x1b[O');
      this.#schedule();
    });

    input.addEventListener('keydown', (e) => {
      if (this.#composing || e.isComposing) return;

      // Ctrl+Shift+C / Ctrl+Shift+V: copy and paste; let the browser deliver the paste event.
      if (e.ctrlKey && e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
        if (e.code === 'KeyC') {
          this.#copySelection();
          e.preventDefault();
        }
        return;
      }
      if (e.shiftKey && !e.ctrlKey && !e.altKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
        this.#scrollBy(e.key === 'PageUp' ? this.screen.rows - 1 : -(this.screen.rows - 1));
        e.preventDefault();
        return;
      }
      if (e.metaKey) return; // leave OS / browser shortcuts alone

      const seq = keyToSequence(e, this.screen.modes);
      if (seq === null) return;
      e.preventDefault();
      this.#userInput(seq);
    });

    input.addEventListener('compositionstart', () => (this.#composing = true));
    input.addEventListener('compositionend', (e) => {
      this.#composing = false;
      this.#userInput(e.data);
      input.value = '';
    });
    // Text that arrives without a handled keydown (on-screen keyboards, voice input, …).
    input.addEventListener('input', () => {
      if (this.#composing) return;
      this.#userInput(input.value);
      input.value = '';
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain');
      if (text) this.#userInput(pasteSequence(text, this.screen.modes.bracketedPaste));
    });
  }

  // ---- mouse: reporting to the host, selection, scrollback ----------------------------------

  #cellFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const { col, row } = this.renderer.cellAt(e.clientX - rect.left, e.clientY - rect.top);
    return {
      col: Math.max(0, Math.min(this.screen.cols - 1, col)),
      row: Math.max(0, Math.min(this.screen.rows - 1, row)),
    };
  }

  #reportsMouse(e) {
    return this.screen.modes.mouse !== 0 && !e.shiftKey;
  }

  #reportMouse(e, button, { release = false, motion = false } = {}) {
    const { col, row } = this.#cellFromEvent(e);
    const seq = mouseSequence(
      { button, col, row, release, motion, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey },
      this.screen.modes.mouseSgr,
    );
    if (seq) this.#emit(seq);
  }

  #bindMouse() {
    const canvas = this.canvas;
    canvas.addEventListener('contextmenu', (e) => {
      if (this.#reportsMouse(e)) e.preventDefault();
    });

    canvas.addEventListener('mousedown', (e) => {
      if (this.#reportsMouse(e)) {
        this.#mouseDown = e.button;
        this.#reportMouse(e, e.button);
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const { col, row } = this.#cellFromEvent(e);
      const abs = this.#absRow(row);
      if (e.detail === 2) {
        this.#selection = this.#wordAt(abs, col);
      } else if (e.detail >= 3) {
        this.#selection = { anchor: { row: abs, col: 0 }, head: { row: abs, col: this.screen.cols } };
      } else {
        this.#selection = { anchor: { row: abs, col }, head: { row: abs, col } };
        this.#selecting = true;
      }
      this.#schedule(true);
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (this.#mouseDown >= 0 && this.screen.modes.mouse >= 1002) {
        this.#reportMouse(e, this.#mouseDown, { motion: true });
        return;
      }
      if (!this.#selecting) return;
      const { col, row } = this.#cellFromEvent(e);
      const rect = this.canvas.getBoundingClientRect();
      const half = e.clientX - rect.left - col * this.renderer.cellWidth > this.renderer.cellWidth / 2;
      this.#selection.head = { row: this.#absRow(row), col: col + (half ? 1 : 0) };
      this.#schedule(true);
    });

    window.addEventListener('mouseup', (e) => {
      if (this.#mouseDown >= 0) {
        this.#reportMouse(e, this.#mouseDown, { release: true });
        this.#mouseDown = -1;
        return;
      }
      if (!this.#selecting) return;
      this.#selecting = false;
      const sel = this.#orderedSelection();
      if (!sel || (sel[0].row === sel[1].row && sel[0].col === sel[1].col)) {
        this.#selection = null;
        this.#schedule(true);
      } else {
        this.#copySelection();
      }
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const lines = Math.max(1, Math.round(Math.abs(e.deltaY) / this.renderer.cellHeight)) || 3;
        const up = e.deltaY < 0;
        if (this.#reportsMouse(e)) {
          for (let i = 0; i < Math.min(lines, 5); i++) this.#reportMouse(e, up ? 64 : 65);
        } else if (this.screen.isAlternate) {
          // Full-screen apps without mouse support (less, man) scroll with arrow keys.
          const key = up ? 'A' : 'B';
          const seq = (this.screen.modes.appCursor ? '\x1bO' : '\x1b[') + key;
          this.#emit(seq.repeat(Math.min(lines, 5)));
        } else {
          this.#scrollBy(up ? lines : -lines);
        }
      },
      { passive: false },
    );
  }

  #scrollBy(lines) {
    const max = this.screen.isAlternate ? 0 : this.screen.scrollback.length;
    const next = Math.max(0, Math.min(max, this.#offset + lines));
    if (next !== this.#offset) {
      this.#offset = next;
      this.#schedule(true);
    }
  }

  #absRow(viewRow) {
    return this.screen.scrollback.length - this.#offset + viewRow;
  }

  #lineAt(abs) {
    const sb = this.screen.scrollback;
    return abs < sb.length ? sb[abs] : this.screen.lines[abs - sb.length];
  }

  #wordAt(abs, col) {
    const line = this.#lineAt(abs);
    if (!line) return null;
    const isWord = (i) => WORD_CHARS.test(line.chars[i] || '') || line.chars[i] === WIDE_TAIL;
    if (!isWord(col)) return { anchor: { row: abs, col }, head: { row: abs, col: col + 1 } };
    let start = col;
    let end = col;
    while (start > 0 && isWord(start - 1)) start--;
    while (end < line.cols - 1 && isWord(end + 1)) end++;
    return { anchor: { row: abs, col: start }, head: { row: abs, col: end + 1 } };
  }

  #orderedSelection() {
    const s = this.#selection;
    if (!s) return null;
    const { anchor: a, head: b } = s;
    return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  }

  selectionText() {
    const sel = this.#orderedSelection();
    if (!sel) return '';
    const [a, b] = sel;
    let out = '';
    for (let row = a.row; row <= b.row; row++) {
      const line = this.#lineAt(row);
      if (!line) continue;
      const from = row === a.row ? a.col : 0;
      const to = row === b.row ? b.col : line.cols;
      out += line.text(from, to).replaceAll(WIDE_TAIL, '');
      if (row !== b.row) {
        if (line.wrapped) continue;
        out = out.trimEnd() + '\n';
      }
    }
    return out.trimEnd();
  }

  #copySelection() {
    const text = this.selectionText();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  }
}
