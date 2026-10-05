// Um cliente wisp v1 mínimo, para a bancada falar com o `server.js` como o transporte do navegador
// fala. O cliente do próprio wisp-js abre o WebSocket pelo construtor global, que não aceita
// cabeçalho, e o upgrade daqui precisa levar o token do app e o nível de rede que o portal escreve.
//
// O formato do pacote: tipo (1 byte), id da stream (4 bytes, little-endian) e o corpo. CONNECT leva
// o tipo de stream (1), a porta (2, LE) e o host; DATA leva os bytes; CONTINUE leva o espaço livre
// (4, LE); CLOSE leva o motivo (1).

import WebSocket from 'ws';

const CONNECT = 0x01;
const DATA = 0x02;
const CLOSE = 0x04;

function pacote(tipo, stream, corpo) {
  const b = Buffer.alloc(5 + corpo.length);
  b.writeUInt8(tipo, 0);
  b.writeUInt32LE(stream, 1);
  corpo.copy(b, 5);
  return b;
}

/**
 * @param {string} url  `ws://host:porta/.../wisp/`
 * @param {Record<string,string>} [cabecalhos]
 */
export async function conectarWisp(url, cabecalhos = {}) {
  const ws = new WebSocket(url, { headers: cabecalhos });
  await new Promise((ok, erro) => { ws.once('open', ok); ws.once('error', erro); });

  const streams = new Map();
  let proximo = 1;

  ws.on('message', (dados) => {
    const b = Buffer.from(dados);
    const tipo = b.readUInt8(0);
    const st = streams.get(b.readUInt32LE(1));
    if (!st) return;
    if (tipo === DATA) st.aoDado(b.subarray(5));
    else if (tipo === CLOSE) st.aoFechar(b.readUInt8(5));
  });

  return {
    ws,
    /** Abre uma stream TCP e devolve quem escreve nela e espera o que volta. */
    abrir(host, porta, { guardar = true } = {}) {
      const id = proximo++;
      const recebidos = [];
      let contados = 0;
      let fechou = null;
      const esperas = [];
      const acordar = () => { for (const f of esperas.splice(0)) f(); };
      streams.set(id, {
        aoDado: (b) => { contados += b.length; if (guardar) recebidos.push(b); acordar(); },
        aoFechar: (motivo) => { fechou = motivo; acordar(); },
      });
      const corpo = Buffer.alloc(3 + Buffer.byteLength(host));
      corpo.writeUInt8(0x01, 0);
      corpo.writeUInt16LE(porta, 1);
      corpo.write(host, 3);
      ws.send(pacote(CONNECT, id, corpo));
      return {
        enviar: (bytes) => ws.send(pacote(DATA, id, Buffer.from(bytes))),
        bytes: () => Buffer.concat(recebidos),
        /** Quantos bytes chegaram, guardados ou não. */
        contados: () => contados,
        motivoDoFechamento: () => fechou,
        /** Espera até `condicao()` valer, ou lança depois de `prazoMs`. */
        async esperar(condicao, prazoMs = 5000) {
          const limite = Date.now() + prazoMs;
          while (!condicao()) {
            const resta = limite - Date.now();
            if (resta <= 0) throw new Error(`a stream ${host}:${porta} não chegou ao estado esperado em ${prazoMs} ms`);
            await new Promise((ok) => { esperas.push(ok); setTimeout(ok, Math.min(resta, 50)); });
          }
        },
      };
    },
    fechar: () => ws.close(),
  };
}
