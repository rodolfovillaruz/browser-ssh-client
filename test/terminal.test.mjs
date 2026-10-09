import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Screen, ATTR, RGB_FLAG, DEFAULT_COLOR } from '../src/term/screen.js';
import { Parser } from '../src/term/parser.js';

function term(cols = 10, rows = 4) {
  const screen = new Screen(cols, rows, { scrollback: 100 });
  const parser = new Parser(screen);
  const responses = [];
  screen.onResponse = (r) => responses.push(r);
  return { screen, write: (s) => parser.write(s), responses };
}

test('prints, wraps and scrolls into scrollback', () => {
  const { screen, write } = term(5, 2);
  write('abcdefg\r\nhi\r\nxy');
  assert.equal(screen.toString(), 'hi\nxy');
  assert.deepEqual(screen.scrollback.map((l) => l.text().trimEnd()), ['abcde', 'fg']);
  assert.ok(screen.scrollback[0].wrapped);
});

test('deferred wrap: writing in the last column does not wrap until the next char', () => {
  const { screen, write } = term(3, 2);
  write('abc');
  assert.deepEqual(screen.cursor, { x: 2, y: 0 });
  assert.ok(screen.pendingWrap);
  write('\r');
  assert.deepEqual(screen.cursor, { x: 0, y: 0 });
});

test('cursor movement and erase', () => {
  const { screen, write } = term(6, 3);
  write('xxxxxx\r\nxxxxxx\r\nxxxxxx');
  write('\x1b[2;3H\x1b[K');
  write('\x1b[3;1H\x1b[1K');
  assert.equal(screen.toString(), 'xxxxxx\nxx\n xxxxx');
  write('\x1b[2J');
  assert.equal(screen.toString(), '');
});

test('SGR: 16, 256 and truecolor (both separators)', () => {
  const { screen, write } = term();
  write('\x1b[1;31mA\x1b[38;5;200;48;2;1;2;3mB\x1b[38:2::10:20:30mC\x1b[0mD');
  const l = screen.lines[0];
  assert.equal(l.fg[0], 1);
  assert.equal(l.attrs[0], ATTR.BOLD);
  assert.equal(l.fg[1], 200);
  assert.equal(l.bg[1], RGB_FLAG | 0x010203);
  assert.equal(l.fg[2], RGB_FLAG | 0x0a141e);
  assert.equal(l.fg[3], DEFAULT_COLOR);
  assert.equal(l.attrs[3], 0);
});

test('scroll region with index and reverse index', () => {
  const { screen, write } = term(3, 4);
  write('1\r\n2\r\n3\r\n4');
  write('\x1b[2;3r'); // rows 2..3
  write('\x1b[3;1H\n');
  assert.equal(screen.toString(), '1\n3\n\n4');
  write('\x1b[2;1H\x1bM');
  assert.equal(screen.toString(), '1\n\n3\n4');
  assert.equal(screen.scrollback.length, 0);
});

test('insert/delete lines and characters', () => {
  const { screen, write } = term(5, 3);
  write('abcde\r\nfghij\r\nklmno');
  write('\x1b[1;2H\x1b[2P');
  assert.equal(screen.lines[0].text(), 'ade  ');
  write('\x1b[1;1H\x1b[2@');
  assert.equal(screen.lines[0].text(), '  ade');
  write('\x1b[2;1H\x1b[L');
  assert.equal(screen.toString(), '  ade\n\nfghij');
  write('\x1b[1;1H\x1b[M');
  assert.equal(screen.toString(), '\nfghij');
});

test('alternate screen 1049 saves and restores the primary screen and cursor', () => {
  const { screen, write } = term(5, 2);
  write('hello\r\nab');
  write('\x1b[?1049h');
  assert.equal(screen.toString(), '');
  write('vim!');
  write('\x1b[?1049l');
  assert.equal(screen.toString(), 'hello\nab');
  assert.deepEqual(screen.cursor, { x: 2, y: 1 });
});

test('wide characters take two cells and wrap early', () => {
  const { screen, write } = term(5, 2);
  write('ab漢字');
  assert.equal(screen.toString(), 'ab漢\n字');
  assert.equal(screen.lines[0].chars[3], '');
});

test('combining marks join the previous cell', () => {
  const { screen, write } = term();
  write('éx');
  assert.equal(screen.lines[0].chars[0], 'é');
  assert.equal(screen.lines[0].chars[1], 'x');
});

test('DEC special graphics line drawing', () => {
  const { screen, write } = term();
  write('\x1b(0lqk\x1b(Bq');
  assert.equal(screen.lines[0].text(0, 4), '┌─┐q');
});

test('device status reports', () => {
  const { write, responses } = term();
  write('\x1b[3;4H\x1b[6n\x1b[c\x1b[>c');
  assert.deepEqual(responses, ['\x1b[3;4R', '\x1b[?62;22c', '\x1b[>0;276;0c']);
});

test('OSC title with BEL and ST terminators; DCS ignored', () => {
  const { screen, write } = term();
  write('\x1b]0;one\x07\x1b]2;two\x1b\\\x1bPq#0;1;2\x1b\\ok');
  assert.equal(screen.title, 'two');
  assert.equal(screen.toString(), 'ok');
});

test('sequences split across writes', () => {
  const { screen, write } = term();
  for (const ch of '\x1b[31mR\x1b]0;t\x07') write(ch);
  assert.equal(screen.lines[0].fg[0], 1);
  assert.equal(screen.title, 't');
});

test('modes: cursor keys, bracketed paste, mouse', () => {
  const { screen, write } = term();
  write('\x1b[?1;2004;1002;1006h\x1b[?25l');
  assert.ok(screen.modes.appCursor && screen.modes.bracketedPaste && screen.modes.mouseSgr);
  assert.equal(screen.modes.mouse, 1002);
  assert.equal(screen.modes.cursorVisible, false);
});

test('resize keeps the cursor line visible', () => {
  const { screen, write } = term(5, 4);
  write('1\r\n2\r\n3\r\n4');
  screen.resize(3, 2);
  assert.equal(screen.toString(), '3\n4');
  assert.deepEqual(screen.cursor, { x: 1, y: 1 });
  assert.equal(screen.scrollback.length, 2);
  screen.resize(8, 3);
  assert.equal(screen.lines.length, 3);
  assert.equal(screen.lines[0].cols, 8);
});

test('tabs', () => {
  const { screen, write } = term(20, 1);
  write('a\tb\x1b[Zc');
  assert.equal(screen.lines[0].text().trimEnd(), 'a       c');
});
