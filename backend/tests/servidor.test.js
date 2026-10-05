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
