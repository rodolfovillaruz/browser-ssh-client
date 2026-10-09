// Canvas 2D renderer for a Screen.

import { ATTR, DEFAULT_COLOR, RGB_FLAG, WIDE_TAIL } from './screen.js';
import { wcwidth } from './wcwidth.js';

export const DEFAULT_THEME = {
  foreground: '#d8dee9',
  background: '#16181d',
  cursor: '#f5c07a',
  selection: 'rgba(120, 160, 255, 0.35)',
  palette: [
    '#20232a', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c8ccd4',
    '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#82c4ff', '#de9bf5', '#7fd7e3', '#ffffff',
  ],
};

function buildPalette(base) {
  const p = [...base];
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) p.push(`rgb(${steps[r]},${steps[g]},${steps[b]})`);
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    p.push(`rgb(${v},${v},${v})`);
  }
  return p;
}

export class Renderer {
  constructor(canvas, { fontFamily, fontSize = 14, theme = DEFAULT_THEME } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.fontFamily = fontFamily ?? "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', 'Liberation Mono', monospace";
    this.fontSize = fontSize;
    this.theme = theme;
    this.palette = buildPalette(theme.palette);
    this.dpr = 1;
    this.measure();
  }

  #font(attrs) {
    const bold = attrs & ATTR.BOLD ? 'bold ' : '';
    const italic = attrs & ATTR.ITALIC ? 'italic ' : '';
    return `${italic}${bold}${this.fontSize}px ${this.fontFamily}`;
  }

  measure() {
    const ctx = this.ctx;
    ctx.font = this.#font(0);
    const m = ctx.measureText('MMMMMMMMMM');
    this.cellWidth = m.width / 10;
    this.cellHeight = Math.ceil(this.fontSize * 1.25);
    const ascent = m.fontBoundingBoxAscent ?? this.fontSize * 0.8;
    const descent = m.fontBoundingBoxDescent ?? this.fontSize * 0.2;
    this.baseline = Math.round((this.cellHeight - (ascent + descent)) / 2 + ascent);
  }

  // Sizes the canvas to the CSS box and returns how many cells fit.
  resize(cssWidth, cssHeight) {
    this.dpr = globalThis.devicePixelRatio || 1;
    const cols = Math.max(2, Math.floor(cssWidth / this.cellWidth));
    const rows = Math.max(1, Math.floor(cssHeight / this.cellHeight));
    const w = Math.ceil(cols * this.cellWidth);
    const h = rows * this.cellHeight;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.textBaseline = 'alphabetic';
    return { cols, rows };
  }

  #color(c, isFg, attrs, reverseVideo) {
    if (c === DEFAULT_COLOR) {
      return isFg !== reverseVideo ? this.theme.foreground : this.theme.background;
    }
    if (c >= RGB_FLAG) return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
    if (isFg && attrs & ATTR.BOLD && c < 8) c += 8;
    return this.palette[c];
  }

  #cellColors(line, x, reverseVideo) {
    const attrs = line.attrs[x];
    let fg = this.#color(line.fg[x], true, attrs, reverseVideo);
    let bg = this.#color(line.bg[x], false, attrs, reverseVideo);
    if (attrs & ATTR.INVERSE) [fg, bg] = [bg, fg];
    if (attrs & ATTR.HIDDEN) fg = bg;
    return { fg, bg, attrs };
  }

  // view: { screen, offset, selection, focused, rows }; rows = Uint8Array of rows to redraw or null for all.
  render({ screen, offset, selection, focused, dirtyRows }) {
    const ctx = this.ctx;
    const { cellWidth: cw, cellHeight: chH } = this;
    const reverse = screen.modes.reverseVideo;
    const sbLen = screen.scrollback.length;
    const top = sbLen - offset;

    for (let row = 0; row < screen.rows; row++) {
      if (dirtyRows && !dirtyRows[row]) continue;
      const abs = top + row;
      const line = abs < sbLen ? screen.scrollback[abs] : screen.lines[abs - sbLen];
      const y = row * chH;

      ctx.fillStyle = reverse ? this.theme.foreground : this.theme.background;
      ctx.fillRect(0, y, screen.cols * cw, chH);
      if (!line) continue;
      const cols = Math.min(screen.cols, line.cols);

      // Backgrounds, merged into runs.
      for (let x = 0; x < cols; ) {
        const { bg } = this.#cellColors(line, x, reverse);
        let end = x + 1;
        while (end < cols && this.#cellColors(line, end, reverse).bg === bg) end++;
        if (bg !== (reverse ? this.theme.foreground : this.theme.background)) {
          ctx.fillStyle = bg;
          ctx.fillRect(Math.floor(x * cw), y, Math.ceil((end - x) * cw), chH);
        }
        x = end;
      }

      // Glyphs and decorations.
      for (let x = 0; x < cols; x++) {
        const ch = line.chars[x];
        if (ch === WIDE_TAIL) continue;
        const { fg, attrs } = this.#cellColors(line, x, reverse);
        const width = ch.length > 1 || ch.charCodeAt(0) > 0x7f ? wcwidth(ch.codePointAt(0)) || 1 : 1;
        if (ch !== ' ') this.#glyph(ch, x, y, fg, attrs, width);
        if (attrs & (ATTR.UNDERLINE | ATTR.STRIKE)) {
          ctx.fillStyle = fg;
          if (attrs & ATTR.UNDERLINE) ctx.fillRect(x * cw, y + chH - 2, cw * width, 1);
          if (attrs & ATTR.STRIKE) ctx.fillRect(x * cw, y + Math.round(chH / 2), cw * width, 1);
        }
      }

      if (selection) this.#selection(selection, abs, row, cols);
    }

    if (offset === 0 && screen.modes.cursorVisible) {
      const { x, y } = screen.cursor;
      if (!dirtyRows || dirtyRows[y]) this.#cursor(screen, x, y, focused);
    }
  }

  #glyph(ch, x, y, fg, attrs, width) {
    const ctx = this.ctx;
    ctx.font = this.#font(attrs);
    ctx.fillStyle = fg;
    ctx.globalAlpha = attrs & ATTR.DIM ? 0.55 : 1;
    const px = x * this.cellWidth;
    if (this.#boxDrawing(ch, px, y, fg)) {
      ctx.globalAlpha = 1;
      return;
    }
    // Fallback-font glyphs can be wider than a cell; squeeze them so the grid stays aligned.
    const maxWidth = this.cellWidth * width;
    ctx.fillText(ch, px, y + this.baseline, ch.length === 1 && ch < '\x80' ? undefined : maxWidth);
    ctx.globalAlpha = 1;
  }

  // Draws common box-drawing lines directly so borders connect without font gaps.
  #boxDrawing(ch, px, py, color) {
    const code = ch.codePointAt(0);
    if (code < 0x2500 || code > 0x257f || ch.length > 1) return false;
    // [left, right, up, down] arms: 1 = light, 2 = heavy, 3 = double (drawn as heavy).
    const arms = BOX[code - 0x2500];
    if (!arms) return false;
    const ctx = this.ctx;
    const w = this.cellWidth;
    const h = this.cellHeight;
    const cx = Math.floor(px + w / 2);
    const cy = Math.floor(py + h / 2);
    ctx.fillStyle = color;
    const t = (n) => (n === 1 ? 1 : 2);
    const [l, r, u, d] = arms;
    if (l) ctx.fillRect(px, cy, cx - px + t(l), t(l));
    if (r) ctx.fillRect(cx, cy, px + w - cx + 1, t(r));
    if (u) ctx.fillRect(cx, py, t(u), cy - py + t(u));
    if (d) ctx.fillRect(cx, cy, t(d), py + h - cy);
    return true;
  }

  #selection(sel, abs, row, cols) {
    const [a, b] = sel;
    if (abs < a.row || abs > b.row) return;
    const from = abs === a.row ? a.col : 0;
    const to = abs === b.row ? b.col : cols;
    if (to <= from) return;
    this.ctx.fillStyle = this.theme.selection;
    this.ctx.fillRect(from * this.cellWidth, row * this.cellHeight, (to - from) * this.cellWidth, this.cellHeight);
  }

  #cursor(screen, x, y, focused) {
    const ctx = this.ctx;
    const line = screen.lines[y];
    const px = x * this.cellWidth;
    const py = y * this.cellHeight;
    const wide = line.chars[x + 1] === WIDE_TAIL ? 2 : 1;
    const w = this.cellWidth * wide;
    ctx.fillStyle = this.theme.cursor;
    ctx.strokeStyle = this.theme.cursor;
    if (!focused) {
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, w - 1, this.cellHeight - 1);
    } else if (screen.cursorStyle === 'bar') {
      ctx.fillRect(px, py, 2, this.cellHeight);
    } else if (screen.cursorStyle === 'underline') {
      ctx.fillRect(px, py + this.cellHeight - 2, w, 2);
    } else {
      ctx.fillRect(px, py, w, this.cellHeight);
      const ch = line.chars[x];
      if (ch && ch !== ' ') {
        const { bg, attrs } = this.#cellColors(line, x, screen.modes.reverseVideo);
        this.#glyph(ch, x, py, bg, attrs, wide);
      }
    }
  }

  // Converts a canvas-relative CSS pixel position into a cell position.
  cellAt(px, py) {
    return { col: Math.floor(px / this.cellWidth), row: Math.floor(py / this.cellHeight) };
  }
}

// Box-drawing table for U+2500..U+257F: [left, right, up, down].
const BOX = (() => {
  const t = new Array(0x80);
  const set = (code, l, r, u, d) => (t[code - 0x2500] = [l, r, u, d]);
  set(0x2500, 1, 1, 0, 0); set(0x2501, 2, 2, 0, 0); set(0x2502, 0, 0, 1, 1); set(0x2503, 0, 0, 2, 2);
  set(0x250c, 0, 1, 0, 1); set(0x250f, 0, 2, 0, 2); set(0x2510, 1, 0, 0, 1); set(0x2513, 2, 0, 0, 2);
  set(0x2514, 0, 1, 1, 0); set(0x2517, 0, 2, 2, 0); set(0x2518, 1, 0, 1, 0); set(0x251b, 2, 0, 2, 0);
  set(0x251c, 0, 1, 1, 1); set(0x2523, 0, 2, 2, 2); set(0x2524, 1, 0, 1, 1); set(0x252b, 2, 0, 2, 2);
  set(0x252c, 1, 1, 0, 1); set(0x2533, 2, 2, 0, 2); set(0x2534, 1, 1, 1, 0); set(0x253b, 2, 2, 2, 0);
  set(0x253c, 1, 1, 1, 1); set(0x254b, 2, 2, 2, 2);
  set(0x2550, 3, 3, 0, 0); set(0x2551, 0, 0, 3, 3); set(0x2554, 0, 3, 0, 3); set(0x2557, 3, 0, 0, 3);
  set(0x255a, 0, 3, 3, 0); set(0x255d, 3, 0, 3, 0); set(0x2560, 0, 3, 3, 3); set(0x2563, 3, 0, 3, 3);
  set(0x2566, 3, 3, 0, 3); set(0x2569, 3, 3, 3, 0); set(0x256c, 3, 3, 3, 3);
  set(0x2574, 1, 0, 0, 0); set(0x2575, 0, 0, 1, 0); set(0x2576, 0, 1, 0, 0); set(0x2577, 0, 0, 0, 1);
  return t;
})();
