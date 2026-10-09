// SSH user authentication (RFC 4252) with keyboard-interactive (RFC 4256).

import { Writer, Reader } from './wire.js';
import { MSG } from './transport.js';

const USERAUTH_REQUEST = 50;
const USERAUTH_FAILURE = 51;
const USERAUTH_SUCCESS = 52;
const USERAUTH_BANNER = 53;
const USERAUTH_60 = 60; // PK_OK / PASSWD_CHANGEREQ / INFO_REQUEST, depending on method
const USERAUTH_INFO_RESPONSE = 61;

const SERVICE = 'ssh-connection';

export class AuthError extends Error {}

// Options:
//   username
//   privateKey   result of parsePrivateKey(), optional
//   password     string, optional
//   prompt({ name, instruction, prompts: [{ prompt, echo }] }) => Promise<string[]>
//   onBanner(text)
export async function authenticate(transport, options) {
  const { username } = options;

  await transport.send(new Writer().byte(MSG.SERVICE_REQUEST).string('ssh-userauth').bytes());
  const accept = await transport.recv();
  if (accept[0] !== MSG.SERVICE_ACCEPT) throw new AuthError('server refused ssh-userauth service');

  const request = (method) =>
    new Writer(512).byte(USERAUTH_REQUEST).string(username).string(SERVICE).string(method);

  // Reads the next auth reply, handling banners. Returns { success } or { methods, partial }.
  const reply = async (handle60) => {
    for (;;) {
      const msg = await transport.recv();
      const r = new Reader(msg, 1);
      switch (msg[0]) {
        case USERAUTH_SUCCESS:
          return { success: true };
        case USERAUTH_FAILURE:
          return { success: false, methods: r.nameList(), partial: r.bool() };
        case USERAUTH_BANNER:
          options.onBanner?.(r.text());
          break;
        case USERAUTH_60:
          if (!handle60) throw new AuthError('unexpected authentication message');
          await handle60(r);
          break;
        default:
          throw new AuthError(`unexpected message ${msg[0]} during authentication`);
      }
    }
  };

  const askPassword = async () => {
    if (options.password != null) return options.password;
    const [answer] = await options.prompt({
      name: '',
      instruction: '',
      prompts: [{ prompt: `${username}'s password: `, echo: false }],
    });
    return answer;
  };

  const attempts = {
    publickey: async () => {
      const key = options.privateKey;
      const body = request('publickey').bool(true).string(key.algorithm).string(key.publicBlob);
      const signed = new Writer(512).string(transport.sessionId).raw(body.bytes()).bytes();
      body.string(await key.sign(signed));
      await transport.send(body.bytes());
      return reply();
    },

    password: async () => {
      const password = await askPassword();
      await transport.send(request('password').bool(false).string(password).bytes());
      return reply(() => {
        throw new AuthError('password expired; change it with another client first');
      });
    },

    'keyboard-interactive': async () => {
      await transport.send(request('keyboard-interactive').string('').string('').bytes());
      let usedPassword = false;
      return reply(async (r) => {
        const name = r.text();
        const instruction = r.text();
        r.text(); // language tag
        const prompts = [];
        for (let n = r.uint32(); n > 0; n--) prompts.push({ prompt: r.text(), echo: r.bool() });

        let answers;
        // Most servers implement passwords as one hidden keyboard-interactive prompt.
        const passwordLike = prompts.length === 1 && !prompts[0].echo;
        if (passwordLike && options.password != null && !usedPassword) {
          answers = [options.password];
          usedPassword = true;
        } else if (prompts.length === 0) {
          answers = [];
        } else {
          answers = await options.prompt({ name, instruction, prompts });
        }

        const w = new Writer().byte(USERAUTH_INFO_RESPONSE).uint32(answers.length);
        for (const a of answers) w.string(a);
        await transport.send(w.bytes());
      });
    },
  };

  await transport.send(request('none').bytes());
  let result = await reply();
  const tried = new Set();

  while (!result.success) {
    const next = ['publickey', 'password', 'keyboard-interactive'].find(
      (m) =>
        result.methods.includes(m) &&
        !tried.has(m) &&
        (m !== 'publickey' || options.privateKey) &&
        (m === 'publickey' || options.password != null || options.prompt),
    );
    if (!next) {
      throw new AuthError(`authentication failed (server allows: ${result.methods.join(', ')})`);
    }
    tried.add(next);
    result = await attempts[next]();
    if (result.partial) tried.clear();
  }
}
