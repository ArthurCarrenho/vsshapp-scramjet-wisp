'use strict';

// app-listen — onde o backend de um vssh-app escuta, num lugar só.
//
// Por que isto existe: até a Onda 9 todo vssh-app fazia `server.listen(PORT, '127.0.0.1')`, e essa
// porta é alcançável por QUALQUER outra conta Linux da máquina — o loopback é compartilhado por
// definição. Não era hipótese: medindo de uma conta comum em `ipprivm01`, das 23 portas de app em
// escuta, **14 responderam a um GET sem token** (10 com 200 e 4 com 500), e 12 delas pertenciam a
// outras contas. O `X-Vssh-App-Token` existe para isso, mas conferi-lo sempre foi opcional, e
// "opcional" com um terminal ou um editor do outro lado é execução de código alcançável por quem
// não deveria.
//
// Um socket unix em `~/.vssh-apps/<id>/` — diretório que o `vssh-app-run` já cria 0700 — resolve por
// permissão de arquivo o que a conferência de token só prometia. E resolve de graça um segundo
// problema, que era de orquestração: um caminho de socket é DERIVADO da identidade (usuário, appId),
// então não precisa ser alocado, descoberto, cacheado nem reconciliado, ao contrário de um número de
// porta escasso.
//
// ── Por que um helper, e não uma linha em cada app ──
//
// Porque são três armadilhas, e todo mundo erra as três na primeira vez:
//
//  1. **O arquivo de socket sobrevive ao processo.** Com TCP, morrer libera a porta; com socket
//     unix, o inode fica no disco e o `bind()` seguinte falha com EADDRINUSE. Quem não limpa fica
//     morto até alguém apagar um arquivo à mão.
//  2. **O modo do arquivo vem do umask**, e um umask frouxo (0022) cria o socket 0755 — que é
//     conectável por qualquer um se o diretório algum dia deixar de ser 0700. Duas defesas, não uma.
//  3. **`listen(path)` e `listen(port, host)` têm assinaturas diferentes**, e escrever `if` em cada
//     app é o começo de N implementações que divergem. Um portão, não N `if`s.
//
// ── A precedência, declarada ──
//
//   VSSH_APP_SOCKET  →  socket unix (o padrão desde a Onda 9)
//   VSSH_APP_PORT    →  TCP em 127.0.0.1, para runtime que não sabe bindar socket
//
// Aceitar as DUAS é o que torna a migração segura em qualquer ordem de deploy: um app já atualizado
// continua funcionando num servidor cujo `vssh-app-run` ainda manda porta, e vice-versa. É por isso
// que a checagem é por presença da variável, e não por um terceiro campo dizendo qual usar — um
// terceiro campo seria uma segunda noção do mesmo fato, esperando para discordar da primeira.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

/**
 * O endereço que este processo deve usar, lido do ambiente. Exportado à parte porque um app às
 * vezes precisa DIZER onde está (log de boot, healthcheck próprio) sem escutar de novo.
 *
 * @returns {{transporte: 'socket', caminho: string} | {transporte: 'tcp', porta: number}}
 */
function enderecoDoAmbiente(env = process.env) {
  const sock = (env.VSSH_APP_SOCKET || '').trim();
  if (sock) return { transporte: 'socket', caminho: sock };

  const porta = Number(env.VSSH_APP_PORT);
  if (Number.isInteger(porta) && porta > 0 && porta < 65536) {
    return { transporte: 'tcp', porta };
  }

  throw new Error(
    'Nem VSSH_APP_SOCKET nem VSSH_APP_PORT vieram do lifecycle. Rodando à mão? Defina um dos dois: ' +
    'VSSH_APP_SOCKET=/tmp/meu-app.sock ou VSSH_APP_PORT=45999.'
  );
}

/**
 * Remove um socket órfão — arquivo que existe e que ninguém atende.
 *
 * NUNCA remove um socket VIVO: a checagem é uma tentativa de conexão, não um `existsSync`. Apagar
 * pelo simples fato de o arquivo existir derrubaria a instância que está atendendo agora, e o
 * sintoma (o app "reinicia sozinho" quando alguém o abre duas vezes) não aponta para cá.
 *
 * @returns {Promise<'inexistente'|'vivo'|'removido'>}
 */
function limparSocketOrfao(caminho) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(caminho)) return resolve('inexistente');

    const probe = net.connect(caminho);
    const encerra = (r) => { probe.destroy(); resolve(r); };
    probe.setTimeout(2000);
    probe.on('connect', () => encerra('vivo'));
    probe.on('timeout', () => encerra('vivo'));   // alguém aceitou e travou: não é órfão
    probe.on('error', () => {
      probe.destroy();
      try {
        fs.unlinkSync(caminho);
        resolve('removido');
      } catch (err) {
        if (err.code === 'ENOENT') return resolve('inexistente');
        reject(err);
      }
    });
  });
}

/**
 * Põe o servidor a escutar no endereço que o ambiente mandou.
 *
 * @param {import('node:http').Server|import('node:net').Server} server
 * @param {{env?: NodeJS.ProcessEnv, modo?: number, tcpEsperado?: boolean}} [opts]
 *        `modo` é a permissão do socket (0o600); `tcpEsperado` silencia o aviso de TCP para um app
 *        que declarou `backend.transport: "tcp"` no manifesto — a escolha deliberada não é o
 *        defeito que o aviso persegue.
 * @returns {Promise<{transporte: string, endereco: string}>} resolve quando está aceitando conexão
 */
async function escutar(server, opts = {}) {
  const env = opts.env || process.env;
  const modo = opts.modo === undefined ? 0o600 : opts.modo;
  const alvo = enderecoDoAmbiente(env);

  if (alvo.transporte === 'tcp') {
    await new Promise((ok, erro) => {
      server.once('error', erro);
      server.listen(alvo.porta, '127.0.0.1', ok);
    });

    // O ramo TCP não é apagado ainda, e também não fica calado.
    //
    // Ele existe para uma coisa só: um app já na v3 caindo num servidor cujo `vssh-app-run` é
    // anterior à Onda 9 e ainda exporta porta. Sem ele, o app não sobe — com ele, sobe e funciona.
    // Mas legado silencioso é como um ramo desses atravessa anos: ninguém sabe se ainda há alguém
    // usando, então ninguém apaga.
    //
    // Então ele ANUNCIA, e nomeia o que consertar. O dia de apagar este bloco é o dia em que esta
    // linha não aparecer no `run.log` de servidor nenhum — decisão com evidência, e não com
    // coragem. Um app que escolheu TCP DE PROPÓSITO (`backend.transport: "tcp"` no manifesto, para
    // um runtime que não sabe bindar socket) silencia o aviso declarando `tcpEsperado: true`.
    if (!opts.tcpEsperado) {
      process.stderr.write(
        `[vssh-app-listen] escutando em TCP (127.0.0.1:${alvo.porta}) porque só veio VSSH_APP_PORT. ` +
        'Desde a Onda 9 o endereço padrão é um socket unix; este servidor tem um `vssh-app-run` ' +
        'anterior a ela. O app funciona, mas a porta é alcançável por qualquer conta Linux da ' +
        'máquina. Atualize o provisionamento do servidor, ou declare `backend.transport: "tcp"` ' +
        'no manifesto se a escolha for deliberada.\n'
      );
    }
    return { transporte: 'tcp', endereco: `127.0.0.1:${alvo.porta}` };
  }

  fs.mkdirSync(path.dirname(alvo.caminho), { recursive: true, mode: 0o700 });
  const estado = await limparSocketOrfao(alvo.caminho);
  if (estado === 'vivo') {
    // Não é erro de programação e não deve virar stack trace: significa que o app já está de pé.
    // Quem chamou decide se sai com 0 (é o que o lifecycle espera) ou reclama.
    const err = new Error(`Já há um backend atendendo em ${alvo.caminho}.`);
    err.code = 'VSSH_APP_JA_ESCUTANDO';
    throw err;
  }

  await new Promise((ok, erro) => {
    server.once('error', erro);
    server.listen(alvo.caminho, ok);
  });
  // Depois do listen, porque antes dele o arquivo não existe. O diretório 0700 já basta; isto é a
  // segunda defesa, para o dia em que o diretório mudar de modo por outra razão.
  try { fs.chmodSync(alvo.caminho, modo); } catch { /* o diretório já protege */ }

  return { transporte: 'socket', endereco: alvo.caminho };
}

module.exports = { escutar, enderecoDoAmbiente, limparSocketOrfao };
