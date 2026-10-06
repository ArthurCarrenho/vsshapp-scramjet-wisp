export type LifecycleHooks = {
	navigate: {
		context: {
			type: "location" | "history" | "hashchange";
			// vssh fork: só com `type: "history"`.
			historico?: "push" | "replace";
		};
		props: {
			url: string;
		};
	};
};
