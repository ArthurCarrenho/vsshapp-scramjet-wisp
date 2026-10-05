// O processo do motor de pé, atendendo o que uma página consegue mandar. A página proxiada roda na
// origem do portal e alcança as rotas deste backend com `fetch`, então todo caminho estático é dado
// de fora, e nenhum deles pode derrubar o processo: com ele cai o wisp de todas as abas.

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { subirServidor, runtimeAusente } from './subir-servidor.js';

const pulo = runtimeAusente() || false;
let srv;

before(async () => { if (!pulo) srv = await subirServidor(); });
after(async () => { await srv?.encerrar(); });

test('um escape malformado no caminho responde 400, e o processo segue atendendo', { skip: pulo }, async () => {
  for (const caminho of ['/scram/%E0%A4%A', '/controller/%', '/libcurl/%zz.js', '/utils/a%E0']) {
    const r = await fetch(srv.url + caminho);
    assert.equal(r.status, 400, `${caminho} respondeu ${r.status}`);
  }
  const raiz = await fetch(srv.url + '/');
  assert.equal(raiz.status, 200, srv.saida());
  assert.ok(srv.vivo(), srv.saida());
});

test('o traversal codificado continua recusado com 400', { skip: pulo }, async () => {
  const r = await fetch(srv.url + '/scram/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd');
  assert.equal(r.status, 400);
});

test('/versao diz a versão do motor e o BUILD.json de cada pacote, sem cache', { skip: pulo }, async () => {
  const r = await fetch(srv.url + '/versao');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const corpo = await r.json();
  assert.match(corpo.versao, /^[0-9a-f]{16}$/);
  for (const pacote of ['scramjet', 'controller', 'utils', 'libcurl-transport']) {
    assert.ok(corpo.pacotes[pacote]?.fonte, `${pacote} sem fonte: ${JSON.stringify(corpo.pacotes)}`);
  }
});

test('a URL com a versão atual sai imutável, e com outra versão sai o arquivo atual sem cache', { skip: pulo }, async () => {
  const { versao } = await (await fetch(srv.url + '/versao')).json();
  const semVersao = await fetch(srv.url + '/controller/controller.inject.js');
  const atual = await fetch(`${srv.url}/v/${versao}/controller/controller.inject.js`);
  const velha = await fetch(srv.url + '/v/0000000000000000/controller/controller.inject.js');

  assert.equal(semVersao.headers.get('cache-control'), 'no-store');
  assert.equal(atual.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(velha.status, 200);
  assert.equal(velha.headers.get('cache-control'), 'no-store');

  const bytes = await semVersao.arrayBuffer();
  assert.ok(bytes.byteLength > 0);
  assert.deepEqual(Buffer.from(await atual.arrayBuffer()), Buffer.from(bytes));
  assert.deepEqual(Buffer.from(await velha.arrayBuffer()), Buffer.from(bytes));
});

test('o traversal continua recusado dentro da URL versionada', { skip: pulo }, async () => {
  const { versao } = await (await fetch(srv.url + '/versao')).json();
  const r = await fetch(`${srv.url}/v/${versao}/scram/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd`);
  assert.equal(r.status, 400);
});
