// Que versão de cada dependência está REALMENTE em disco, e ela bate com o que o lockfile manda?
//
// Isto existe por causa de um incidente concreto. O `installCommand` do manifesto gateava por
// `test -d node_modules` — "a pasta existe, logo está instalado". Uma pasta existe para sempre,
// então nenhum bump de dependência era aplicado depois da primeira instalação. Produção serviu
// `@mercuryworkshop/scramjet` **2.0.67-alpha.4** enquanto o lockfile declarava **alpha.10**, por seis
// releases seguidas — incluindo uma correção de isolamento entre origens proxiadas.
//
// O gate foi consertado. O que não existia era o **jeito de perceber**: nada no boot dizia qual
// versão estava rodando, então a divergência só apareceu comparando números de linha de um stack
// trace do console do usuário contra os sourcemaps de cada release. Isso é arqueologia, não
// operação.
//
// Por isso a comparação, e não só a listagem. Saber que roda "alpha.4" não ajuda se ninguém lembra
// o que deveria ser; o que responde à pergunta é `alpha.4 != alpha.10`.
//
// Tudo injetável (`lerJson`), porque a bancada precisa montar árvores divergentes sem escrever em
// node_modules.

import path from 'node:path';
import { readFileSync } from 'node:fs';

/** Lê um JSON, devolvendo `null` se não der — nunca lança. */
function lerJsonDoDisco(caminho) {
  try {
    return JSON.parse(readFileSync(caminho, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Confere o que está instalado contra o que o lockfile declara.
 *
 * @param {object} opcoes
 * @param {string}  opcoes.raiz     diretório com package.json/package-lock.json/node_modules
 * @param {Function} [opcoes.lerJson] injeção para a bancada; assinatura (caminho) => objeto|null
 * @returns {{pacotes: Array, divergentes: Array, lockAusente: boolean}}
 */
export function conferirVersoes({ raiz, lerJson = lerJsonDoDisco } = {}) {
  const manifesto = lerJson(path.join(raiz, 'package.json')) || {};
  const lock = lerJson(path.join(raiz, 'package-lock.json'));
  const declaradas = Object.keys(manifesto.dependencies || {}).sort();

  const pacotes = declaradas.map((nome) => {
    // A versão instalada vem do package.json DO PACOTE, lido por caminho e não por
    // `require.resolve(nome + '/package.json')`: muitos pacotes modernos não expõem `./package.json`
    // no `exports`, e ali o resolve lança ERR_PACKAGE_PATH_NOT_EXPORTED. O que se quer aqui é o
    // arquivo em disco, não o grafo de módulos.
    const instalado = lerJson(path.join(raiz, 'node_modules', ...nome.split('/'), 'package.json'));

    // O lockfile v2/v3 chaveia por caminho de instalação, sempre com barra normal (é formato, não
    // caminho do SO) — por isso não se usa path.join aqui.
    const noLock = lock?.packages?.[`node_modules/${nome}`] ?? null;

    const declarado = noLock?.version ?? null;
    const emDisco = instalado?.version ?? null;

    let estado;
    if (!emDisco) estado = 'ausente';
    else if (!declarado) estado = 'sem-lock';
    else if (declarado !== emDisco) estado = 'divergente';
    else estado = 'ok';

    return { nome, declarado, instalado: emDisco, estado };
  });

  return {
    pacotes,
    // 'ausente' entra junto de 'divergente': os dois significam "o que está em disco não é o que foi
    // pedido", e é essa a pergunta. Separá-los aqui só faria quem lê o log ter que reunir de novo.
    divergentes: pacotes.filter((p) => p.estado === 'divergente' || p.estado === 'ausente'),
    lockAusente: !lock,
  };
}

/** Uma linha por pacote, para o stdout — `nome dd.dd.dd` ou `nome dd.dd.dd (lockfile pede xx.xx.xx)`. */
export function resumirVersoes(relatorio) {
  return relatorio.pacotes.map((p) => {
    if (p.estado === 'ausente') return `${p.nome} AUSENTE (lockfile pede ${p.declarado ?? '?'})`;
    if (p.estado === 'divergente') return `${p.nome} ${p.instalado} != ${p.declarado} DO LOCKFILE`;
    return `${p.nome} ${p.instalado}`;
  });
}
