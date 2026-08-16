// delete all chrome specific apis, or apis that are not supported by any browser other than chrome
// these are not worth emulating and typically cause issues

import { iswindow } from "@client/entry";
import { ScramjetClient } from "@client/index";

// type self as any here, most of these are not defined in the types
export default function (client: ScramjetClient, self: any) {
	const del = (name: string) => {
		const split = name.split(".");
		const prop = split.pop();
		const target = split.reduce((a, b) => a?.[b], self);
		if (!target) return;
		if (prop && prop in target) {
			delete target[prop];
		} else {
		}
	};

	// obviously
	// del("chrome");

	// ShapeDetector https://developer.chrome.com/docs/capabilities/shape-detection
	del("BarcodeDetector");
	del("FaceDetector");
	del("TextDetector");

	// background synchronization api e `joinAdInterestGroup`: passaram a ser NEUTRALIZADOS em vez
	// de apagados — ver o bloco "existir sem poder fazer" mais abaixo.

	if (!iswindow) return;
	// DOM specific ones below here

	// `Navigator.prototype.serviceWorker` continua sendo apagado, e é a exceção consciente do
	// bloco abaixo: ele não é fingerprint, é ISOLAMENTO. Com ele de volta, a página proxiada
	// enxerga e registra Service Worker próprio, colidindo com o do motor — que é quem roteia
	// tudo. Devolvê-lo exige um shim que finja um registro sem conceder nenhum, e isso é
	// trabalho de verdade, não uma linha.
	Reflect.deleteProperty(Navigator.prototype, "serviceWorker");

	// contact picker api
	del("Navigator.prototype.contacts");
	del("ContactAddress");
	del("ContactManager");

	// ─── vssh fork: existir sem poder fazer ──────────────────────────────────────────────
	//
	// **Apagar isto denunciava o proxy.** Medido num Chrome 151 real: das 42 APIs que este
	// arquivo apagava, **36 existem** num Chrome de verdade. E o User-Agent não é tocado em
	// lugar nenhum — ou seja, a página proxiada se apresentava como Chromium com 36 APIs de
	// Chromium faltando, combinação que nenhum Chrome real produz. Para um desafio de bot,
	// `'Bluetooth' in window` é uma linha.
	//
	// Só que **devolver estas APIs inteiras seria pior que a doença**: elas rodam no navegador
	// REAL de quem lê, não num sandbox. Com `navigator.hid` de volta, uma página proxiada hostil
	// pediria acesso a dispositivo USB da máquina da pessoa; `IdleDetector` reportaria quando ela
	// saiu da frente do computador; `Bluetooth` e `Presentation` abririam seletor de dispositivo.
	// O `del()` protegia disso — só protegia de um jeito visível a quilômetros.
	//
	// Então o objeto de interface FICA (é nativo, e passa em qualquer introspecção: tipo,
	// `prototype`, `name`, `Symbol.toStringTag`) e o que se neutraliza é **só o método que
	// concede a capacidade**. O comportamento escolhido em cada caso é o que um Chrome real faz
	// quando o usuário recusa — um caminho que todo site que usa estas APIs já precisa tratar.
	//
	// ⚠ Limite conhecido: `Function.prototype.toString` sobre um método neutralizado devolve
	// fonte JS em vez de `[native code]`. Fechar isso exige mexer no `Function.prototype.toString`
	// global, e fica registrado como o próximo passo se algum desafio olhar tão fundo.
	const recusar = (nome: string) =>
		function () {
			return Promise.reject(
				new DOMException(`User denied the request for ${nome}.`, "NotAllowedError")
			);
		};

	// Troca UM método, deixando o objeto de interface intacto.
	const neutralizar = (caminho: string, recuo: (...args: any[]) => any) => {
		const partes = caminho.split(".");
		const prop = partes.pop();
		const alvo = partes.reduce((a: any, b: string) => a?.[b], self);
		if (!alvo || !prop || !(prop in alvo)) return;
		try {
			Object.defineProperty(alvo, prop, {
				value: recuo,
				writable: true,
				enumerable: false,
				configurable: true,
			});
		} catch {
			// alvo não-configurável: deixar como está é melhor que derrubar o hook inteiro
		}
	};

	// Web Bluetooth: o seletor de dispositivo é do navegador real.
	neutralizar("Bluetooth.prototype.requestDevice", recusar("Bluetooth"));
	neutralizar("Bluetooth.prototype.getDevices", function () {
		return Promise.resolve([]);
	});
	neutralizar("Bluetooth.prototype.getAvailability", function () {
		return Promise.resolve(false);
	});

	// WebHID: no Chrome, `requestDevice` resolve com lista VAZIA quando o usuário não escolhe
	// nada. É a resposta mais fiel, e não é sequer um erro que o site precise tratar.
	neutralizar("HID.prototype.requestDevice", function () {
		return Promise.resolve([]);
	});
	neutralizar("HID.prototype.getDevices", function () {
		return Promise.resolve([]);
	});

	// Idle Detection: saber que a pessoa saiu da frente do computador não é coisa que um site
	// proxiado deva descobrir.
	neutralizar("IdleDetector.requestPermission", function () {
		return Promise.resolve("denied");
	});
	neutralizar("IdleDetector.prototype.start", recusar("IdleDetector"));

	// Presentation API: abre seletor de tela/dispositivo no navegador real.
	neutralizar("PresentationRequest.prototype.start", recusar("Presentation"));
	neutralizar("PresentationRequest.prototype.reconnect", recusar("Presentation"));
	neutralizar("PresentationRequest.prototype.getAvailability", function () {
		return Promise.reject(
			new DOMException("Presentation is not available.", "NotSupportedError")
		);
	});

	// Background Sync: registraria uma tarefa no Service Worker DO MOTOR. O alvo é o
	// `SyncManager`, e não `ServiceWorkerRegistration.prototype.sync` — este último é um GETTER
	// que exige instância, e lê-lo do protótipo lançaria "Illegal invocation".
	neutralizar("SyncManager.prototype.register", recusar("Background Sync"));
	neutralizar("SyncManager.prototype.getTags", function () {
		return Promise.resolve([]);
	});

	// Protected Audience: entraria num grupo de interesse com a chave da origem do PROXY — que é
	// compartilhada por todos os sites proxiados.
	neutralizar("Navigator.prototype.joinAdInterestGroup", recusar("joinAdInterestGroup"));

	// `WindowControlsOverlay` e `MediaDevices.prototype.setCaptureHandleConfig` ficam intocados:
	// o primeiro é geometria somente-leitura (numa aba ele já reporta invisível) e o segundo só
	// rotula uma captura que precisaria ter sido concedida antes. Nenhum dos dois concede nada.

	// Navigation API (not chrome only but it's really annoying to implement)
	del("navigation");
	del("NavigateEvent");
	del("NavigationActivation");
	del("NavigationCurrentEntryChangeEvent");
	del("NavigationDestination");
	del("NavigationHistoryEntry");
	del("NavigationTransition");
}
