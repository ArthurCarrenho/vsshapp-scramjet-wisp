// Onde a mensagem do botão de fechar se perde?
//
// Já sabemos: o #close-button vive no iframe do chat, o painel a recolher vive no pai, o filho
// enxerga o pai corretamente (parent !== self), o clique não lança — e nada acontece.
//
// Restam três lugares para a mensagem morrer:
//   1. o filho nem chama postMessage (o handler do botão quebrou antes)
//   2. chama, e nada chega no pai
//   3. chega no pai com a ORIGEM errada, e o listener do YouTube descarta
//
// (3) é o suspeito forte: é a mesma família do defeito do reCAPTCHA — origem real do portal vazando
// no lugar da proxiada. Um listener que confere `event.origin` descarta calado, que é exatamente o
// sintoma "clico e não acontece nada".
//
// Este script instrumenta AS DUAS PONTAS antes de clicar.
import { pathToFileURL } from 'node:url';

const { chromium, esperarServidor } = await import("./comum.mjs");
const BASE = process.env.BENCH_DEMO || 'http://localhost:4141';
const ALVO = process.env.BENCH_ALVO || 'https://www.youtube.com/watch?v=wTXQ_-jD8Lw';
const ESPERA = Number(process.env.BENCH_ESPERA || 30000);
const LIMITE = Number(process.env.BENCH_LIMITE || 240000);
const morte = setTimeout(() => { console.log(`\n[abortado: ${LIMITE}ms]`); process.exit(2); }, LIMITE);
morte.unref?.();

const FUNDO = `function fundo(raiz, seletor, vistos = new Set()) {
	if (!raiz || vistos.has(raiz)) return null;
	vistos.add(raiz);
	const d = raiz.querySelector && raiz.querySelector(seletor);
	if (d) return d;
	for (const el of (raiz.querySelectorAll ? raiz.querySelectorAll('*') : [])) {
		if (el.shadowRoot) { const a = fundo(el.shadowRoot, seletor, vistos); if (a) return a; }
	}
	return null;
}`;

// O devserver do fork (`npm run dev`) é pré-requisito destes scripts, e não sobe sozinho.
// Falhar aqui, nomeando o endereço, é melhor que falhar dentro do Playwright com um erro
// de navegação que não diz o que está faltando.
await esperarServidor(BASE, 15000);

const browser = await chromium.launch();
try {
	const ctx = await browser.newContext({
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
		viewport: { width: 1600, height: 900 }, locale: 'pt-BR',
	});
	const page = await ctx.newPage();
	await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
	const input = await page.waitForSelector('input[type="text"], input:not([type]), input[type="url"], input[type="search"]', { timeout: 20000 });
	await input.fill(ALVO);
	await input.press('Enter');
	await page.waitForTimeout(ESPERA);

	const yt = page.frames().find((f) => f.url().includes('youtube.com%2Fwatch'));
	await yt.evaluate(() => {
		const chat = document.querySelector('ytd-live-chat-frame');
		if (chat && chat.hasAttribute('collapsed')) {
			(document.querySelector('#show-hide-button button') || document.querySelector('#show-hide-button'))?.click();
		}
	});
	await page.waitForTimeout(12000);

	// ── Ponta receptora: tudo que chega no pai ──
	await yt.evaluate(`(() => {
		window.__recebidas = [];
		window.addEventListener('message', (e) => {
			let d; try { d = typeof e.data === 'string' ? e.data.slice(0, 120) : JSON.stringify(e.data).slice(0, 120); } catch { d = '(nao serializa)'; }
			window.__recebidas.push({ origem: e.origin, dado: d, deIframe: e.source !== window });
		}, true);
	})()`);

	// ── Ponta emissora: tudo que o filho manda ──
	const chatFrame = page.frames().find((f) => f.url().includes('live_chat_replay'));
	await chatFrame.evaluate(`(() => {
		window.__enviadas = [];
		const alvo = parent;
		const original = alvo.postMessage.bind(alvo);
		try {
			alvo.postMessage = function (...args) {
				let d; try { d = typeof args[0] === 'string' ? args[0].slice(0, 120) : JSON.stringify(args[0]).slice(0, 120); } catch { d = '(nao serializa)'; }
				window.__enviadas.push({ dado: d, destino: String(args[1]).slice(0, 60) });
				return original(...args);
			};
		} catch (e) { window.__enviadas.push({ erro: 'nao consegui envolver: ' + String(e).slice(0, 80) }); }
	})()`);

	const clique = await chatFrame.evaluate(`(() => {
		${FUNDO}
		const el = fundo(document, '#close-button');
		if (!el) return 'nao achei';
		const btn = fundo(el, 'button') || el;
		try { btn.click(); return 'cliquei'; } catch (e) { return 'lancou: ' + String(e).slice(0, 90); }
	})()`);
	console.log('clique:', clique);
	await page.waitForTimeout(3000);

	const enviadas = await chatFrame.evaluate('window.__enviadas || []');
	const recebidas = await yt.evaluate('window.__recebidas || []');
	const final = await yt.evaluate(`(() => { const c = document.querySelector('ytd-live-chat-frame'); return { collapsed: c && c.hasAttribute('collapsed'), altura: c ? Math.round(c.getBoundingClientRect().height) : null }; })()`);

	console.log(`\n=== o filho ENVIOU (${enviadas.length}) ===`);
	for (const e of enviadas.slice(0, 12)) console.log('  ', JSON.stringify(e));
	console.log(`\n=== o pai RECEBEU (${recebidas.length}) ===`);
	for (const r of recebidas.slice(0, 12)) console.log('  ', JSON.stringify(r));
	console.log('\n=== painel ao final ===');
	console.log('  ', JSON.stringify(final));
} finally {
	await browser.close().catch(() => {});
	clearTimeout(morte);
}
