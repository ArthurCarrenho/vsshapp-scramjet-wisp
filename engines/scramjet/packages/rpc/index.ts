type Serverbound = {
	method1: [{ paramA: string; paramB: number }, boolean];
	method2: [string, number];
};

type Clientbound = {
	method1: [number];
	method2: [boolean, string];
};

export type RpcDescription = {
	[method: string]: [args: any, returnType: any] | [args: any] | [];
};

export type MethodsDefinition<Description extends RpcDescription> = {
	[Method in keyof Description]: (
		...args: Description[Method] extends [infer A, ...any[]] ? [A] : []
	) => Description[Method] extends [any, infer R]
		? Promise<[R, Transferable[]]>
		: Promise<void>;
};

export class RpcHelper<
	Local extends RpcDescription,
	Remote extends RpcDescription,
> {
	counter: number = 0;
	promiseCallbacks: Map<
		number,
		{ resolve: (value: any) => void; reject: (reason?: any) => void }
	> = new Map();
	constructor(
		private methods: MethodsDefinition<Local>,
		private id: string,
		private sendRaw: (data: any, transfer: Transferable[]) => void
	) {}

	recieve(data: any) {
		if (data === undefined || data === null || typeof data !== "object") return;
		const dt = data[this.id];
		if (dt === undefined || dt === null || typeof dt !== "object") return;

		const type = dt.$type;

		if (type === "response") {
			const token = dt.$token;
			const data = dt.$data;
			const error = dt.$error;
			const cb = this.promiseCallbacks.get(token);
			if (!cb) return;
			this.promiseCallbacks.delete(token);
			if (error !== undefined) {
				cb.reject(new Error(error));
			} else {
				cb.resolve(data);
			}
		} else if (type === "request") {
			const method = dt.$method as keyof Local;
			const args = dt.$args as Local[typeof method][0];
			(this.methods[method] as any)(args)
				.then((r: any) => {
					this.sendRaw(
						{
							[this.id]: {
								$type: "response",
								$token: dt.$token,
								$data: r?.[0],
							},
						},
						r?.[1]
					);
				})
				.catch((err: any) => {
					console.error(err);
					this.sendRaw(
						{
							[this.id]: {
								$type: "response",
								$token: dt.$token,
								$error: err?.toString() || "Unknown error",
							},
						},
						[]
					);
				});
		}
	}

	// vssh fork: **rejeita tudo que está em voo.** Uma chamada guarda `{resolve, reject}` no mapa e
	// espera a resposta chegar pelo canal; se o canal MORRE, essa resposta não vai chegar nunca — e
	// a promessa não resolve nem rejeita. Quem deu `await` fica pendurado para sempre, e a entrada
	// no mapa também: é promessa presa e vazamento no mesmo lugar.
	//
	// Não é hipótese: `setupMessagePort` fecha a porta anterior e manda uma nova ao Service Worker,
	// e o SW tira a referência antiga do array `tabs`. Toda chamada que estava em voo naquele
	// instante caiu nesse buraco.
	//
	// Por que isto em vez de um teto de tempo: o que estas chamadas carregam inclui `request`, ou
	// seja, uma requisição HTTP inteira pelo túnel. Um teto que não atrapalhasse download de 2 GB
	// seria longo demais para servir de rede de segurança, e um teto curto quebraria o download. O
	// evento que importa não é "demorou", é "o canal não existe mais" — e esse é observável.
	rejectPending(reason: string) {
		if (!this.promiseCallbacks.size) return;
		const pendentes = [...this.promiseCallbacks.values()];
		this.promiseCallbacks.clear();
		for (const cb of pendentes) {
			try {
				cb.reject(new Error(reason));
			} catch {
				// um chamador que lança no próprio catch não pode impedir os outros de serem avisados
			}
		}
	}

	// vssh fork: **herda o que ficou em voo, quando o canal foi TROCADO e não perdido.** Rejeitar é
	// a resposta certa para "o outro lado sumiu"; é a errada para "o outro lado reconectou", que é
	// o que acontece a cada `$controller$swrevive` — ou seja, ~100 ms depois de todo Service Worker
	// ativar, bem no meio do carregamento da página.
	//
	// A resposta de uma chamada feita na porta velha sai pela porta NOVA: quem responde usa
	// `this.port`, que já foi trocada, e o `$token` continua sendo o da chamada original. Ela chega,
	// portanto — só que no helper novo, que não conhece aquele token e a descarta em `if (!cb)`.
	// Adotar o mapa faz a resposta encontrar quem a espera.
	//
	// ⚠ O contador vem junto, e é isso que impede o pior caso: cada helper novo começa do zero, e
	// dois tokens iguais vivos ao mesmo tempo fazem uma resposta resolver a promessa ERRADA — uma
	// requisição recebendo o corpo de outra, sem erro nenhum. Herdar o contador garante que todo
	// token novo é maior que qualquer token adotado.
	adotarPendentes(anterior: RpcHelper<any, any>) {
		for (const [token, cb] of anterior.promiseCallbacks) {
			this.promiseCallbacks.set(token, cb);
		}
		anterior.promiseCallbacks.clear();
		if (anterior.counter > this.counter) this.counter = anterior.counter;
	}

	call<Method extends keyof Remote>(
		method: Method,
		args: Remote[Method][0],
		transfer: Transferable[] = []
	): Promise<Remote[Method][1]> {
		const token = this.counter++;
		return new Promise((resolve, reject) => {
			this.promiseCallbacks.set(token, { resolve, reject });
			this.sendRaw(
				{
					[this.id]: {
						$type: "request",
						$method: method,
						$args: args,
						$token: token,
					},
				},
				transfer
			);
		});
	}
}
