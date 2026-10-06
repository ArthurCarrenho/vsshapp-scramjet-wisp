// O socket TCP de cada stream wisp: a conexão que o motor abre, a partir do servidor, para o destino
// que a página pediu. O wisp-js aceita uma classe própria por conexão
// (`routeRequest(req, socket, head, { TCPSocket })`), e esta substitui o `NodeTCPSocket` do pacote
// em três pontos:
//
//   - a régua de destinos (`decidirDestino`, em `rede.js`) roda sobre o endereço resolvido, com o
//     nível de rede da conexão, e o socket conecta nesse mesmo endereço;
//   - o freio: quando a página para de ler, o `ServerStream` do wisp-js para de pedir dados (ele
//     espera o `ws.send` drenar), a fila daqui enche, e o socket pausa a origem. A fila tem teto de
//     `limiteDaFila` pedaços, e a leitura volta quando ela cai à metade. O `NodeTCPSocket` do pacote
//     enfileira sem teto e retoma a origem a cada pedaço enviado, e um consumidor parado levava o
//     processo a gigabytes;
//   - o prazo de inatividade: um socket sem tráfego em nenhum sentido por `ociosoMs` fecha. O
//     libcurl do navegador fecha uma conexão parada no cache dele em ~2 min e as páginas mandam
//     ping nos WebSockets, então o prazo só alcança stream abandonada.
//
// O wisp-js chama `pause()` antes de cada envio pelo WebSocket e `resume()` depois. Os dois são
// vazios aqui: quem decide pausar é a fila.

import net from 'node:net';
import { decidirDestino } from './rede.js';

export class DestinoRecusado extends Error {
  constructor(hostname, porta, motivo) {
    super(`destino recusado pela régua de rede: ${hostname}:${porta} (${motivo})`);
    this.motivo = motivo;
  }
}

/**
 * Uma classe de socket TCP para as streams de UMA conexão wisp.
 *
 * @param {object}   opcoes
 * @param {number}   [opcoes.nivel]        nível de rede da conexão (cabeçalho `X-Vssh-Rede-Nivel`)
 * @param {Function} opcoes.resolver       `hostname => Promise<ip>` (o `dns_method` da política)
 * @param {Function} [opcoes.decidir]      a régua (`decidirDestino`); injetável na bancada
 * @param {Function} [opcoes.aoRecusar]    `({ hostname, porta, ip, classe, motivo }) => void`
 * @param {Function} [opcoes.aoDesfecho]   `(desfecho) => void`, uma vez por stream: `conectou`, `recusado`
 *                                         (a régua) ou `falhou` (a resolução ou a conexão)
 * @param {number}   [opcoes.limiteDaFila] pedaços na fila antes de pausar a origem
 * @param {number}   [opcoes.ociosoMs]     prazo de inatividade do socket
 * @param {Function} [opcoes.conectar]     `net.connect` (injetável)
 */
export function criarSocketTcp({
  nivel = 0,
  resolver,
  decidir = decidirDestino,
  aoRecusar,
  aoDesfecho,
  limiteDaFila = 16,
  ociosoMs = 10 * 60_000,
  conectar = (destino) => net.connect(destino),
} = {}) {
  const desfecho = (d) => { try { aoDesfecho?.(d); } catch { /* medir não muda a conexão */ } };
  return class SocketTcpDoMotor {
    constructor(hostname, port) {
      this.hostname = hostname;
      this.port = port;
      this.socket = null;
      this.connected = false;
      this._fila = [];
      this._esperando = null;
      this._fim = false;
      this._pausado = false;
    }

    async connect() {
      let ip;
      try {
        ip = net.isIP(this.hostname) ? this.hostname : await resolver(this.hostname);
      } catch (erro) {
        desfecho('falhou');
        throw erro;
      }
      const decisao = decidir({ ip, porta: this.port, nivel });
      if (!decisao.permitido) {
        try {
          aoRecusar?.({ hostname: this.hostname, porta: this.port, ip, classe: decisao.classe, motivo: decisao.motivo });
        } catch { /* diagnóstico não muda a decisão */ }
        desfecho('recusado');
        throw new DestinoRecusado(this.hostname, this.port, decisao.motivo);
      }

      await new Promise((resolve, reject) => {
        const socket = conectar({ host: ip, port: this.port });
        this.socket = socket;
        socket.setNoDelay(true);
        socket.setTimeout(ociosoMs, () => socket.destroy());
        socket.on('connect', () => { this.connected = true; desfecho('conectou'); resolve(); });
        socket.on('data', (pedaco) => this._receber(pedaco));
        socket.on('close', () => {
          if (!this.connected) {
            desfecho('falhou');
            reject(new Error(`a conexão a ${this.hostname}:${this.port} não abriu`));
          }
          this._encerrar();
        });
        // O `close` vem logo depois, e é ele que encerra; sem ouvinte, o `error` derrubaria o processo.
        socket.on('error', () => {});
        // O wisp não tem meio-fechamento: o fim do lado de lá encerra a stream.
        socket.on('end', () => socket.destroy());
      });
    }

    _receber(pedaco) {
      if (this._esperando) {
        const entregar = this._esperando;
        this._esperando = null;
        entregar(pedaco);
        return;
      }
      this._fila.push(pedaco);
      if (this._fila.length >= limiteDaFila && !this._pausado && this.socket) {
        this.socket.pause();
        this._pausado = true;
      }
    }

    _encerrar() {
      this._fim = true;
      this.socket = null;
      if (this._esperando) {
        const entregar = this._esperando;
        this._esperando = null;
        entregar(null);
      }
    }

    /** O próximo pedaço, ou `null` quando a conexão acabou e a fila esvaziou. */
    async recv() {
      if (this._fila.length) {
        const pedaco = this._fila.shift();
        if (this._pausado && this._fila.length <= limiteDaFila / 2) {
          this._pausado = false;
          this.socket?.resume();
        }
        return pedaco;
      }
      if (this._fim) return null;
      return new Promise((resolve) => { this._esperando = resolve; });
    }

    async send(dados) {
      const socket = this.socket;
      if (!socket) return;
      await new Promise((resolve) => socket.write(dados, () => resolve()));
    }

    async close() {
      const socket = this.socket;
      if (!socket) return;
      socket.end();
    }

    pause() {}
    resume() {}
  };
}
