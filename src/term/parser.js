// Escape sequence parser modeled on the DEC VT500 state machine (vt100.net/emu/dec_ansi_parser).
// Input is decoded text; output is calls on a handler with this interface (Screen implements it):
//   print(text), execute(code), esc(intermediates, final),
//   csi(prefix, params, intermediates, final), osc(data)

const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI_PARAM = 3;
const CSI_INTERMEDIATE = 4;
const CSI_IGNORE = 5;
const OSC = 6;
const STRING_IGNORE = 7; // DCS, SOS, PM, APC: consumed and dropped
const STRING_ESC = 8; // ESC seen inside OSC / ignored string, expecting '\'

const MAX_PARAMS = 32;
const MAX_OSC = 65536;

export class Parser {
  #state = GROUND;
  #prefix = '';
  #intermediates = '';
  #params = [];
  #osc = '';
  #stringIsOsc = false;

  constructor(handler) {
    this.handler = handler;
  }

  write(text) {
    const h = this.handler;
    const len = text.length;
    let i = 0;

    while (i < len) {
      const code = text.charCodeAt(i);

      if (this.#state === GROUND) {
        if (code >= 0x20 && code !== 0x7f) {
          // Hand over the whole printable run at once.
          let end = i + 1;
          while (end < len) {
            const c = text.charCodeAt(end);
            if (c < 0x20 || c === 0x7f) break;
            end++;
          }
          h.print(text.slice(i, end));
          i = end;
          continue;
        }
        if (code === 0x1b) this.#enterEscape();
        else if (code !== 0x7f) h.execute(code);
        i++;
        continue;
      }

      i++;

      // Controls that act in every state (except inside strings, handled below).
      if (this.#state < OSC) {
        if (code === 0x18 || code === 0x1a) {
          this.#state = GROUND;
          continue;
        }
        if (code === 0x1b) {
          this.#enterEscape();
          continue;
        }
        if (code < 0x20) {
          h.execute(code);
          continue;
        }
      }

      const ch = text[i - 1];
      switch (this.#state) {
        case ESCAPE:
          if (code >= 0x20 && code <= 0x2f) {
            this.#intermediates += ch;
            this.#state = ESCAPE_INTERMEDIATE;
          } else if (ch === '[') {
            this.#prefix = '';
            this.#params = [];
            this.#state = CSI_PARAM;
          } else if (ch === ']') {
            this.#startString(true);
          } else if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') {
            this.#startString(false);
          } else if (code >= 0x30 && code <= 0x7e) {
            this.#state = GROUND;
            h.esc('', ch);
          } else {
            this.#state = GROUND;
          }
          break;

        case ESCAPE_INTERMEDIATE:
          if (code >= 0x20 && code <= 0x2f) {
            this.#intermediates += ch;
          } else {
            this.#state = GROUND;
            if (code >= 0x30 && code <= 0x7e) h.esc(this.#intermediates, ch);
          }
          break;

        case CSI_PARAM:
          if (code >= 0x30 && code <= 0x39) {
            this.#digit(code - 0x30);
          } else if (ch === ';') {
            if (this.#params.length === 0) this.#params.push([]);
            if (this.#params.length < MAX_PARAMS) this.#params.push([]);
          } else if (ch === ':') {
            if (this.#params.length === 0) this.#params.push([]);
            const cur = this.#params[this.#params.length - 1];
            if (cur.length === 0) cur.push(undefined);
            cur.push(undefined);
          } else if (code >= 0x3c && code <= 0x3f) {
            // Private prefix ('<', '=', '>', '?') is only valid before any parameter.
            if (this.#params.length === 0 && !this.#prefix) this.#prefix = ch;
            else this.#state = CSI_IGNORE;
          } else if (code >= 0x20 && code <= 0x2f) {
            this.#intermediates += ch;
            this.#state = CSI_INTERMEDIATE;
          } else if (code >= 0x40 && code <= 0x7e) {
            this.#dispatchCsi(ch);
          } else {
            this.#state = CSI_IGNORE;
          }
          break;

        case CSI_INTERMEDIATE:
          if (code >= 0x20 && code <= 0x2f) this.#intermediates += ch;
          else if (code >= 0x40 && code <= 0x7e) this.#dispatchCsi(ch);
          else this.#state = CSI_IGNORE;
          break;

        case CSI_IGNORE:
          if (code >= 0x40 && code <= 0x7e) this.#state = GROUND;
          break;

        case OSC:
        case STRING_IGNORE:
          if (code === 0x07) {
            this.#finishString();
          } else if (code === 0x1b) {
            this.#state = STRING_ESC;
          } else if (code === 0x18 || code === 0x1a) {
            this.#state = GROUND;
          } else if (this.#state === OSC && this.#osc.length < MAX_OSC) {
            this.#osc += ch;
          }
          break;

        case STRING_ESC:
          this.#finishString();
          // Anything other than ST ('\') starts a new escape sequence.
          if (ch !== '\\') {
            this.#enterEscape();
            i--;
            this.#state = ESCAPE;
          }
          break;
      }
    }
  }

  #enterEscape() {
    this.#state = ESCAPE;
    this.#intermediates = '';
  }

  #startString(isOsc) {
    this.#stringIsOsc = isOsc;
    this.#osc = '';
    this.#state = isOsc ? OSC : STRING_IGNORE;
  }

  #finishString() {
    this.#state = GROUND;
    if (this.#stringIsOsc) this.handler.osc(this.#osc);
    this.#stringIsOsc = false;
    this.#osc = '';
  }

  #digit(d) {
    if (this.#params.length === 0) this.#params.push([]);
    const cur = this.#params[this.#params.length - 1];
    const last = cur.length === 0 ? 0 : cur.length - 1;
    cur[last] = Math.min(((cur[last] ?? 0) * 10) + d, 65535);
  }

  #dispatchCsi(final) {
    this.#state = GROUND;
    this.handler.csi(this.#prefix, this.#params, this.#intermediates, final);
  }
}
