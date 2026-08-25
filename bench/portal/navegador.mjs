// De onde vem o Chromium desta bancada.
//
// `comum.mjs` resolve o PACOTE do playwright; o que falta é o BINÁRIO. Um playwright recém
// instalado espera a build exata que ele pinou, e uma máquina que já tem outra (um contêiner de
// CI, um checkout do fork) responde `Executable doesn't exist at …chromium_headless_shell-1234`,
// que é o erro mais fácil de ler como "a bancada está quebrada".
//
// `BENCH_CHROME` aponta o binário e resolve os dois casos. Sem ele, o padrão do playwright vale.

import { chromium } from "../comum.mjs";

export async function abrirNavegador(opcoes = {}) {
	const executablePath = process.env.BENCH_CHROME || undefined;
	return chromium.launch({ headless: process.env.HEADED !== "1", executablePath, ...opcoes });
}
