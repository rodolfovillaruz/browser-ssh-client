// High-level SSH client: transport + authentication + connection.

import { Transport } from './transport.js';
import { authenticate } from './auth.js';
import { Connection } from './connection.js';

export { parsePrivateKey } from './openssh-key.js';

export class SshClient {
  // socket: see transport.js. options: { username, password, privateKey, prompt, onBanner, verifyHostKey }
  static async connect(socket, options) {
    const transport = new Transport(socket, { verifyHostKey: options.verifyHostKey });
    try {
      await transport.connect();
      await authenticate(transport, options);
    } catch (err) {
      transport.close().catch(() => {});
      throw err;
    }
    return new SshClient(transport);
  }

  constructor(transport) {
    this.transport = transport;
    this.connection = new Connection(transport);
  }

  get hostKeyFingerprint() {
    return this.transport.hostKeyFingerprint;
  }

  set onclose(fn) {
    this.connection.onclose = fn;
  }

  async shell({ cols, rows, term } = {}) {
    const channel = await this.connection.openSession();
    await channel.requestPty({ cols, rows, term });
    await channel.shell();
    return channel;
  }

  async exec(command) {
    const channel = await this.connection.openSession();
    await channel.exec(command);
    return channel;
  }

  close() {
    return this.transport.close();
  }
}
