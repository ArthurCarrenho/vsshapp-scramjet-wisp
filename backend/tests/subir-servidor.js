// Sobe o `server.js` de verdade numa porta de bancada e devolve o endereço. É o processo inteiro,
// com o wisp, o estático e o portão de token: o que se mede aqui é o que o portal alcança.
//
// O runtime `vssh` vem do `NODE_PATH` (no CI, a ação `preparar-sdk` do vssh-sdk o exporta; numa
// máquina de desenvolvimento, `source scripts/ambiente-de-dev.sh` do vssh-sdk). Sem ele o servidor
// não escuta, e `runtimeAusente()` diz isso para o teste se pular nomeando o que falta.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** O motivo do pulo, ou `null` quando o runtime `vssh` resolve pelo `NODE_PATH`. */
export function runtimeAusente() {
  try {
    // O mesmo `createRequire` do `server.js`: o Node lê o `NODE_PATH` na partida do processo, e a
    // bancada herda o mesmo ambiente que o filho vai herdar.
    createRequire(path.join(BACKEND, 'server.js')).resolve('vssh');
    return null;
  } catch {
    return 'o runtime vssh não está no NODE_PATH (source scripts/ambiente-de-dev.sh do vssh-sdk)';
  }
}

/**
 * @param {{ env?: Record<string,string> }} [opcoes]
 * @returns {Promise<{ url: string, host: string, porta: number, pid: number, dados: string, saida: () => string, vivo: () => boolean, encerrar: () => Promise<void> }>}
 */
export async function subirServidor({ env = {} } = {}) {
  const dados = mkdtempSync(path.join(tmpdir(), 'scramjet-wisp-bancada-'));
  const filho = spawn(process.execPath, [path.join(BACKEND, 'server.js'), '--tcp', '127.0.0.1:0'], {
    env: { ...process.env, VSSH_APP_DATA_DIR: dados, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let saida = '';
  let saiu = false;
  filho.stdout.on('data', (b) => { saida += b; });
  filho.stderr.on('data', (b) => { saida += b; });
  filho.on('exit', () => { saiu = true; });

  const endereco = await new Promise((ok, erro) => {
    const prazo = setTimeout(() => erro(new Error(`o servidor não anunciou o endereço em 10 s:\n${saida}`)), 10_000);
    const olhar = () => {
      const m = /escutando em (127\.0\.0\.1):(\d+)/.exec(saida);
      if (m) { clearTimeout(prazo); ok({ host: m[1], porta: Number(m[2]) }); }
    };
    filho.stdout.on('data', olhar);
    filho.on('exit', (codigo) => { clearTimeout(prazo); erro(new Error(`o servidor saiu com ${codigo} antes de escutar:\n${saida}`)); });
  });

  return {
    url: `http://${endereco.host}:${endereco.porta}`,
    host: endereco.host,
    porta: endereco.porta,
    pid: filho.pid,
    dados,
    saida: () => saida,
    vivo: () => !saiu,
    async encerrar() {
      if (!saiu) {
        const fim = new Promise((ok) => filho.once('exit', ok));
        filho.kill('SIGTERM');
        await fim;
      }
      rmSync(dados, { recursive: true, force: true });
    },
  };
}
