// A cegueira que este módulo conserta já aconteceu: produção serviu `@mercuryworkshop/scramjet`
// 2.0.67-alpha.4 durante seis releases enquanto o lockfile declarava alpha.10, e a divergência só
// foi descoberta batendo números de linha de um stack trace contra os sourcemaps de cada versão.
//
// O que se mede aqui é que `conferirVersoes` reconhece uma divergência quando ela existe — e, tão
// importante quanto, que não grita quando não existe. Um aviso que aparece sempre é ignorado
// sempre, e aí o módulo não conserta nada.
//
// Sem disco: `lerJson` é injetado, então a bancada monta árvores impossíveis (pacote ausente,
// lockfile faltando) sem tocar em node_modules.

import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { conferirVersoes, resumirVersoes } from '../versoes.js';

const RAIZ = '/app/backend';

/**
 * Monta um `lerJson` de mentira a partir de duas tabelas simples.
 * @param {object} manifesto  dependências declaradas em package.json
 * @param {object} lock       nome -> versão no package-lock.json (null = fora do lock)
 * @param {object} disco      nome -> versão instalada (ausente = não instalado)
 */
function arvore({ manifesto, lock, disco, semLock = false }) {
  return (caminho) => {
    const rel = path.relative(RAIZ, caminho).split(path.sep).join('/');
    if (rel === 'package.json') return { dependencies: manifesto };
    if (rel === 'package-lock.json') {
      if (semLock) return null;
      return {
        packages: Object.fromEntries(
          Object.entries(lock).map(([nome, versao]) => [`node_modules/${nome}`, { version: versao }])
        ),
      };
    }
    const m = rel.match(/^node_modules\/(.+)\/package\.json$/);
    if (m && disco[m[1]]) return { version: disco[m[1]] };
    return null;
  };
}

// ─── O caso que originou tudo ────────────────────────────────────────────────────────────

test('acusa o pacote que ficou para trás do lockfile', () => {
  const r = conferirVersoes({
    raiz: RAIZ,
    lerJson: arvore({
      manifesto: { '@mercuryworkshop/scramjet': 'https://…/scramjet-2.0.67-alpha.10.tgz' },
      lock:      { '@mercuryworkshop/scramjet': '2.0.67-alpha.10' },
      disco:     { '@mercuryworkshop/scramjet': '2.0.67-alpha.4' },
    }),
  });

  assert.equal(r.divergentes.length, 1);
  assert.deepEqual(r.pacotes[0], {
    nome: '@mercuryworkshop/scramjet',
    declarado: '2.0.67-alpha.10',
    instalado: '2.0.67-alpha.4',
    estado: 'divergente',
  });
});

test('o resumo diz os DOIS números, não só o instalado', () => {
  const r = conferirVersoes({
    raiz: RAIZ,
    lerJson: arvore({
      manifesto: { '@mercuryworkshop/scramjet': 'x' },
      lock:      { '@mercuryworkshop/scramjet': '2.0.67-alpha.10' },
      disco:     { '@mercuryworkshop/scramjet': '2.0.67-alpha.4' },
    }),
  });

  // Saber que roda alpha.4 não resolve nada se quem lê não lembra o que deveria ser. É a
  // comparação que transforma o log em diagnóstico.
  const [linha] = resumirVersoes(r);
  assert.match(linha, /2\.0\.67-alpha\.4/);
  assert.match(linha, /2\.0\.67-alpha\.10/);
});

// ─── Não gritar à toa ────────────────────────────────────────────────────────────────────

test('árvore alinhada não produz nenhuma divergência', () => {
  const versoes = {
    '@mercuryworkshop/scramjet': '2.0.67-alpha.10',
    '@mercuryworkshop/wisp-js': '0.4.1',
    'vssh-app-toolkit': '4.0.0',
  };
  const r = conferirVersoes({
    raiz: RAIZ,
    lerJson: arvore({ manifesto: versoes, lock: versoes, disco: versoes }),
  });

  assert.equal(r.divergentes.length, 0);
  assert.ok(r.pacotes.every((p) => p.estado === 'ok'));
  assert.deepEqual(resumirVersoes(r), [
    '@mercuryworkshop/scramjet 2.0.67-alpha.10',
    '@mercuryworkshop/wisp-js 0.4.1',
    'vssh-app-toolkit 4.0.0',
  ]);
});

// ─── Degradações, que não podem virar exceção ────────────────────────────────────────────

test('pacote não instalado conta como divergente, e é nomeado', () => {
  const r = conferirVersoes({
    raiz: RAIZ,
    lerJson: arvore({
      manifesto: { '@mercuryworkshop/scramjet': 'x', 'vssh-app-toolkit': 'y' },
      lock:      { '@mercuryworkshop/scramjet': '2.0.67-alpha.10', 'vssh-app-toolkit': '4.0.0' },
      disco:     { 'vssh-app-toolkit': '4.0.0' },
    }),
  });

  assert.deepEqual(r.divergentes.map((p) => p.nome), ['@mercuryworkshop/scramjet']);
  assert.equal(r.pacotes[0].estado, 'ausente');
  assert.match(resumirVersoes(r)[0], /AUSENTE/);
});

test('sem package-lock.json avisa em vez de lançar, e ainda lista o instalado', () => {
  const r = conferirVersoes({
    raiz: RAIZ,
    lerJson: arvore({
      manifesto: { '@mercuryworkshop/scramjet': 'x' },
      lock:      {},
      disco:     { '@mercuryworkshop/scramjet': '2.0.67-alpha.10' },
      semLock:   true,
    }),
  });

  assert.equal(r.lockAusente, true);
  assert.equal(r.pacotes[0].estado, 'sem-lock');
  // 'sem-lock' NÃO é divergência: sem lockfile não há com o que comparar, e acusar divergência
  // seria inventar um problema. O aviso do lockfile ausente é outro, e é dado uma vez só.
  assert.equal(r.divergentes.length, 0);
  assert.equal(resumirVersoes(r)[0], '@mercuryworkshop/scramjet 2.0.67-alpha.10');
});

test('árvore ilegível inteira não lança — devolve relatório vazio', () => {
  const r = conferirVersoes({ raiz: RAIZ, lerJson: () => null });
  assert.deepEqual(r.pacotes, []);
  assert.deepEqual(r.divergentes, []);
  assert.equal(r.lockAusente, true);
});

// ─── A árvore de verdade deste repo ──────────────────────────────────────────────────────

test('o backend instalado nesta máquina está alinhado com o próprio lockfile', () => {
  const raiz = path.join(import.meta.dirname, '..');
  const r = conferirVersoes({ raiz });

  assert.ok(r.pacotes.length > 0, 'nenhuma dependência declarada — o teste não mediu nada');
  assert.equal(r.lockAusente, false);
  assert.deepEqual(
    r.divergentes.map((p) => `${p.nome}: disco=${p.instalado ?? 'ausente'} lock=${p.declarado}`),
    [],
  );
});
