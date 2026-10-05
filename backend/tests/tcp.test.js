// O socket de cada stream wisp (`backend/tcp.js`), medido de ponta: o `server.js` de verdade, um
// cliente wisp que manda os cabeçalhos que o portal manda, e destinos TCP reais nesta máquina.
//
// O que se mede: a régua de destinos sobre o endereço resolvido, com o nível da conexão; o teto de
// streams por conexão; e o freio, que segura a memória do processo quando a página para de ler.

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { subirServidor, runtimeAusente } from './subir-servidor.js';
import { conectarWisp } from './cliente-wisp.js';
import { criarSocketTcp } from '../tcp.js';

const TOKEN = 'token-da-bancada';
const NETWORK_ERROR = 0x03;
const CONN_THROTTLED = 0x49;

const pulo = runtimeAusente() || false;
let srv;
let eco;

before(async () => {
  eco = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise((ok) => eco.once('listening', ok));
  if (!pulo) srv = await subirServidor({ env: { VSSH_APP_TOKEN: TOKEN } });
});
after(async () => {
  eco.close();
  await srv?.encerrar();
});

const wispUrl = () => `${srv.url.replace('http', 'ws')}/wisp/`;
const conectar = (nivel) => conectarWisp(wispUrl(), {
  'x-vssh-app-token': TOKEN,
  ...(nivel === undefined ? {} : { 'x-vssh-rede-nivel': String(nivel) }),
});

async function ecoa(cliente, host, porta) {
  const st = cliente.abrir(host, porta);
  st.enviar('oi');
  await st.esperar(() => st.bytes().toString() === 'oi' || st.motivoDoFechamento() !== null);
  return st;
}

test('o dev server da própria conta no loopback abre, sem cabeçalho de nível', { skip: pulo }, async () => {
  const cliente = await conectar();
  try {
    const st = await ecoa(cliente, '127.0.0.1', eco.address().port);
    assert.equal(st.bytes().toString(), 'oi');
    // `localhost` passa pelo resolvedor e chega ao mesmo endereço.
    const porNome = await ecoa(cliente, 'localhost', eco.address().port);
    assert.equal(porNome.bytes().toString(), 'oi');
  } finally {
    cliente.fechar();
  }
});

test('o metadata da nuvem e o 0.0.0.0 fecham na hora, em qualquer nível, sem tentar conectar', { skip: pulo }, async () => {
  const cliente = await conectar(3);
  try {
    for (const [host, porta] of [['169.254.169.254', 80], ['0.0.0.0', eco.address().port]]) {
      const inicio = Date.now();
      const st = cliente.abrir(host, porta);
      // Sem a régua, o SYN para o metadata pendura até o prazo de conexão do sistema, em minutos.
      await st.esperar(() => st.motivoDoFechamento() !== null, 5000);
      assert.equal(st.motivoDoFechamento(), NETWORK_ERROR, host);
      assert.ok(Date.now() - inicio < 3000, `${host} levou ${Date.now() - inicio} ms`);
    }
  } finally {
    cliente.fechar();
  }
  const eventos = readFileSync(`${srv.dados}/app.log`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const recusa = eventos.find((e) => Object.values(e).includes('destino-recusado') && e.ip === '169.254.169.254');
  assert.equal(recusa?.motivo, 'endereco_proibido', JSON.stringify(eventos));
});

// Um endereço privado desta máquina, quando ela tem um (os runners do CI têm 10.x). Escutar nele é
// o único jeito de provar a rede privada aberta pelo nível sem depender de outra máquina.
const privado = Object.values(os.networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(i.address));

test('a rede privada abre com o nível 2 do portal, e fecha sem ele', { skip: pulo || (!privado && 'esta máquina não tem endereço privado') }, async () => {
  const ecoPrivado = net.createServer((s) => s.pipe(s)).listen(0, privado.address);
  await new Promise((ok) => ecoPrivado.once('listening', ok));
  try {
    const porta = ecoPrivado.address().port;
    for (const nivel of [undefined, 0, 1]) {
      const cliente = await conectar(nivel);
      const st = await ecoa(cliente, privado.address, porta);
      assert.equal(st.motivoDoFechamento(), NETWORK_ERROR, `nível ${nivel}`);
      cliente.fechar();
    }
    const cliente = await conectar(2);
    const st = await ecoa(cliente, privado.address, porta);
    assert.equal(st.bytes().toString(), 'oi');
    cliente.fechar();
  } finally {
    ecoPrivado.close();
  }
});

test('uma conexão wisp abre até 128 streams, e a seguinte fecha por excesso', { skip: pulo }, async () => {
  const cliente = await conectar();
  try {
    const streams = [];
    for (let i = 0; i < 130; i++) streams.push(cliente.abrir('127.0.0.1', eco.address().port));
    for (const st of streams) st.enviar('x');
    await Promise.all(streams.map((st) => st.esperar(() => st.motivoDoFechamento() !== null || st.bytes().length > 0)));
    const recusadas = streams.filter((st) => st.motivoDoFechamento() === CONN_THROTTLED).length;
    const abertas = streams.filter((st) => st.bytes().toString() === 'x').length;
    assert.equal(abertas, 128);
    assert.equal(recusadas, 2);
  } finally {
    cliente.fechar();
  }
  assert.ok(srv.vivo(), srv.saida());
});

function rssMb(pid) {
  const linha = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith('VmRSS:'));
  return Number(linha.split(/\s+/)[1]) / 1024;
}

test('com a página parada de ler, a memória do processo fica contida, e nada se perde quando ela volta', { skip: pulo, timeout: 60_000 }, async () => {
  const TOTAL = 300 * 1024 * 1024;
  const pedaco = Buffer.alloc(1024 * 1024, 0x61);
  const origem = net.createServer((s) => {
    let enviado = 0;
    const mandar = () => {
      while (enviado < TOTAL) {
        enviado += pedaco.length;
        if (!s.write(pedaco)) { s.once('drain', mandar); return; }
      }
      s.end();
    };
    mandar();
  }).listen(0, '127.0.0.1');
  await new Promise((ok) => origem.once('listening', ok));

  const cliente = await conectar();
  try {
    const antes = rssMb(srv.pid);
    // A página para de ler: o socket do WebSocket do cliente deixa de consumir o que chega.
    cliente.ws._socket.pause();
    const st = cliente.abrir('127.0.0.1', origem.address().port, { guardar: false });
    await new Promise((ok) => setTimeout(ok, 3000));
    const parado = rssMb(srv.pid);
    assert.ok(parado - antes < 120, `o processo cresceu ${Math.round(parado - antes)} MB com a página parada`);

    cliente.ws._socket.resume();
    await st.esperar(() => st.contados() >= TOTAL || st.motivoDoFechamento() !== null, 40_000);
    assert.equal(st.contados(), TOTAL);
  } finally {
    cliente.fechar();
    origem.close();
  }
});

test('um socket sem tráfego por mais que o prazo de inatividade fecha', async () => {
  const mudo = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((ok) => mudo.once('listening', ok));
  try {
    const Socket = criarSocketTcp({ resolver: async () => '127.0.0.1', ociosoMs: 200 });
    const s = new Socket('127.0.0.1', mudo.address().port);
    await s.connect();
    const inicio = Date.now();
    assert.equal(await s.recv(), null);
    assert.ok(Date.now() - inicio >= 150, `fechou em ${Date.now() - inicio} ms`);
  } finally {
    mudo.close();
  }
});
