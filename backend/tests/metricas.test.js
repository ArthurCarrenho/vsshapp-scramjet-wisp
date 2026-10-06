// As contas que o motor publica no ambiente (`recursos.metricas`), medidas de ponta: o `server.js`
// de verdade com o par de credencial que o portal escreve, e um portal de mentira que recebe o
// `POST /api/metricas` do runtime `vssh`. O runtime manda a cada 10 s, e o caso espera esse envio.

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import { subirServidor, runtimeAusente } from './subir-servidor.js';
import { conectarWisp } from './cliente-wisp.js';

const TOKEN = 'token-da-bancada';
const DO_PORTAL = 'credencial-do-portal';
const pulo = runtimeAusente() || false;

let srv;
let portal;
let eco;
const recebidos = [];

before(async () => {
  if (pulo) return;
  eco = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise((ok) => eco.once('listening', ok));
  portal = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (d) => { corpo += d; });
    req.on('end', () => {
      recebidos.push({ url: req.url, auth: req.headers.authorization, corpo: JSON.parse(corpo || '{}') });
      res.writeHead(204).end();
    });
  }).listen(0, '127.0.0.1');
  await new Promise((ok) => portal.once('listening', ok));
  srv = await subirServidor({
    env: { VSSH_APP_TOKEN: TOKEN, VSSH_PORTAL_URL: `http://127.0.0.1:${portal.address().port}`, VSSH_PORTAL_TOKEN: DO_PORTAL },
  });
});
after(async () => {
  await srv?.encerrar();
  portal?.close();
  eco?.close();
});

/** O upgrade que o servidor recusa: ele fecha o socket sem responder. */
const recusado = (caminho, cabecalhos) => new Promise((ok) => {
  const ws = new WebSocket(`${srv.url.replace('http', 'ws')}${caminho}`, { headers: cabecalhos });
  ws.on('open', () => { ws.close(); ok('abriu'); });
  ws.on('error', () => ok('recusado'));
});

test('as conexões wisp, as streams e os upgrades recusados chegam ao portal como contas do app', { skip: pulo, timeout: 30_000 }, async () => {
  assert.equal(await recusado('/wisp/', { 'x-vssh-app-token': 'outro' }), 'recusado');
  assert.equal(await recusado('/outro-caminho/', { 'x-vssh-app-token': TOKEN }), 'recusado');

  const cliente = await conectarWisp(`${srv.url.replace('http', 'ws')}/wisp/`, { 'x-vssh-app-token': TOKEN, 'x-vssh-rede-nivel': '1' });
  try {
    const aberta = cliente.abrir('127.0.0.1', eco.address().port);
    aberta.enviar('oi');
    await aberta.esperar(() => aberta.bytes().toString() === 'oi');
    const proibida = cliente.abrir('169.254.169.254', 80);
    await proibida.esperar(() => proibida.motivoDoFechamento() !== null, 5000);
  } finally {
    cliente.fechar();
  }

  const fim = Date.now() + 15_000;
  const contas = () => recebidos.filter((r) => r.url === '/api/metricas').flatMap((r) => r.corpo.eventos || []);
  const valor = (nome, rotulos) => contas()
    .filter((e) => e.nome === nome && Object.entries(rotulos).every(([k, v]) => e.rotulos?.[k] === v))
    .reduce((t, e) => t + e.valor, 0);
  while (valor('streams', { desfecho: 'recusado' }) < 1 && Date.now() < fim) await new Promise((r) => setTimeout(r, 200));

  assert.ok(recebidos.every((r) => r.auth === `Bearer ${DO_PORTAL}`), 'um envio saiu sem a credencial do portal');
  assert.equal(valor('upgrades_recusados', { motivo: 'token' }), 1);
  assert.equal(valor('upgrades_recusados', { motivo: 'caminho' }), 1);
  assert.equal(valor('conexoes_wisp', { nivel: '1' }), 1);
  assert.equal(valor('streams', { desfecho: 'conectou' }), 1);
  assert.equal(valor('streams', { desfecho: 'recusado' }), 1, JSON.stringify(contas()));
});
