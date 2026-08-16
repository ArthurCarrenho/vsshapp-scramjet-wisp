// O teste que importa: clicar no #close-button DENTRO do iframe do chat e ver se o painel recolhe.
//
// O botão mora no frame `live_chat_replay`; o painel que precisa recolher (`ytd-live-chat-frame`)
// mora na página pai. Ou seja, o clique só tem efeito se o filho conseguir falar com o pai — que é
// a conversa entre frames que o conserto do wrap.ts endereça.
//
// Descobertas que este script incorpora, cada uma custou uma rodada:
//   - viewport pequeno faz o YouTube servir outro layout, SEM o #close-button
//   - o painel começa recolhido em página de replay; enquanto isso o iframe do chat nem carrega
//   - o botão está em shadow DOM, então querySelector normal não acha
import { pathToFileURL } from 'node:url';

const { chromium, esperarServidor } = await import("./comum.mjs");
const BASE = process.env.BENCH_DEMO || 'http://localhost:4141';
const ALVO = process.env.BENCH_ALVO || 'https://www.youtube.com/watch?v=wTXQ_-jD8Lw';
const ESPERA = Number(process.env.BENCH_ESPERA || 30000);
const LIMITE = Number(process.env.BENCH_LIMITE || 240000);

const morte = setTimeout(() => { console.log(`\n[abortado: estourou ${LIMITE}ms]`); process.exit(2); }, LIMITE);
morte.unref?.();

const FUNDO = `function fundo(raiz, seletor, vistos = new Set()) {
	if (!raiz || vistos.has(raiz)) return null;
	vistos.add(raiz);
	const direto = raiz.querySelector && raiz.querySelector(seletor);
	if (direto) return direto;
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
	const mensagens = [];
	page.on('console', (m) => { if (/postMessage|parent|shady|CAUGHT ERROR/i.test(m.text())) mensagens.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
	page.on('pageerror', (e) => mensagens.push(`pageerror: ${String(e).slice(0, 160)}`));

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

	const estado = async (rotulo) => {
		const r = await yt.evaluate(() => {
			const chat = document.querySelector('ytd-live-chat-frame');
			return {
				collapsed: chat ? chat.hasAttribute('collapsed') : null,
				altura: chat ? Math.round(chat.getBoundingClientRect().height) : null,
			};
		});
		console.log(`  ${rotulo}: ${JSON.stringify(r)}`);
		return r;
	};

	console.log('=== estado do painel na página pai ===');
	const antes = await estado('antes ');

	const chatFrame = page.frames().find((f) => f.url().includes('live_chat_replay'));
	if (!chatFrame) { console.log('\nsem frame de chat — não dá para testar'); process.exit(1); }

	// O que o filho enxerga do pai? É a afirmação central do conserto do wrap.ts.
	const visao = await chatFrame.evaluate(`(() => ({
		parentEhSelf: parent === window,
		topEhSelf: top === window,
		conseguePostar: (() => { try { parent.postMessage({ sonda: 1 }, "*"); return true; } catch (e) { return "lancou: " + e.name; } })(),
	}))()`);
	console.log('\n=== o que o iframe do chat enxerga ===');
	console.log(' ', JSON.stringify(visao));

	const clique = await chatFrame.evaluate(`(() => {
		${FUNDO}
		const el = fundo(document, '#close-button');
		if (!el) return 'nao achei #close-button';
		const btn = fundo(el, 'button') || el;
		const r = btn.getBoundingClientRect();
		try { btn.click(); return 'cliquei em ' + btn.tagName + ' (' + Math.round(r.width) + 'x' + Math.round(r.height) + ')'; }
		catch (e) { return 'click lancou: ' + String(e).slice(0, 100); }
	})()`);
	console.log('\n=== clique ===');
	console.log(' ', clique);

	await page.waitForTimeout(3000);
	console.log('\n=== estado depois ===');
	const depois = await estado('depois');

	console.log(`\nVEREDITO: ${antes.collapsed === depois.collapsed && antes.altura === depois.altura
		? 'NADA MUDOU — defeito reproduzido localmente'
		: 'O PAINEL RECOLHEU — funciona aqui'}`);

	if (mensagens.length) {
		console.log('\n=== console relevante ===');
		const g = {};
		for (const l of mensagens) { const k = l.replace(/\d+/g, 'N').slice(0, 120); g[k] = (g[k] || 0) + 1; }
		for (const [k, n] of Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(3)}x ${k}`);
	}
} finally {
	await browser.close().catch(() => {});
	clearTimeout(morte);
}
