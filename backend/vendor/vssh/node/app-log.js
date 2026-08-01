'use strict';

// app-log — log estruturado em $VSSH_APP_DATA_DIR, para depurar um vssh-app remoto.
//
// Por que isto existe: quando um app se comporta mal num servidor, o que você tem é um frame
// minificado no console do navegador. Frame minificado sustenta hipótese, não conclusão — duas
// atribuições erradas seguidas no port do Logseq vieram exatamente daí, e as duas foram resolvidas
// numa linha pelo log do backend, que nomeia operação e caminho:
//
//     {"ts":"…","event":"op-failed","op":"stat","path":"…/graphs-txid.edn","code":"ENOENT"}
//
// São vinte linhas que se pagam na primeira depuração remota. O lifecycle do portal hoje guarda
// stdout/stderr do backend em `~/.vssh-apps/<id>/run.log`, mas esse arquivo é rotacionado a cada
// start; o log próprio em `$VSSH_APP_DATA_DIR` sobrevive a reinício e é estruturado, então os dois
// se complementam em vez de competir.

const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * @param {object} [options]
 * @param {string} [options.appId]   default: $VSSH_APP_ID
 * @param {string} [options.dataDir] default: $VSSH_APP_DATA_DIR, ou ~/.vssh-apps/<id>/data
 * @param {string} [options.file]    default 'app.log'
 * @param {boolean} [options.stdout] também escreve em stdout (default true)
 * @returns {(event: string, detail?: object) => void}
 */
function createAppLog(options = {}) {
  const appId = options.appId || process.env.VSSH_APP_ID || 'vssh-app';
  const dataDir =
    options.dataDir ||
    process.env.VSSH_APP_DATA_DIR ||
    path.join(os.homedir(), '.vssh-apps', appId, 'data');
  const logPath = path.join(dataDir, options.file || 'app.log');
  const alsoStdout = options.stdout !== false;

  let stream = null;

  function log(event, detail) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + '\n';
    if (alsoStdout) process.stdout.write(line);
    try {
      if (!stream) {
        fsSync.mkdirSync(dataDir, { recursive: true });
        stream = fsSync.createWriteStream(logPath, { flags: 'a' });
      }
      stream.write(line);
    } catch {
      // Se nem o log grava, não há para onde reportar — seguir servindo é melhor que morrer por
      // causa do diagnóstico.
    }
  }

  log.path = logPath;
  return log;
}

module.exports = { createAppLog };
