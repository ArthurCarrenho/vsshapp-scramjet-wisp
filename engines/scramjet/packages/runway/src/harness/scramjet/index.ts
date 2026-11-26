import fs from "node:fs";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve paths relative to the package root (runway/)
const packageRoot = path.resolve(__dirname, "../../..");

export const PORT = 4500;
export const WISP_PORT = 4501;

export async function startHarness() {
	const app = express();

	app.use(
		"/scramjet",
		express.static(
			path.join(packageRoot, "node_modules/@mercuryworkshop/scramjet/dist")
		)
	);

	app.use(
		"/controller",
		express.static(
			path.join(
				packageRoot,
				"node_modules/@mercuryworkshop/scramjet-controller/dist"
			)
		)
	);

	// O transporte que a produção usa é o do repositório (`backend/vendor/libcurl-transport`), e é ele
	// que o harness serve quando existe. O do npm é outro, e um defeito dele (a query vazia `?` que
	// some) aparecia como defeito do motor.
	const libcurlDoRepositorio = path.join(packageRoot, "../../../../backend/vendor/libcurl-transport/dist");
	app.use(
		"/libcurl",
		express.static(
			fs.existsSync(path.join(libcurlDoRepositorio, "index.js"))
				? libcurlDoRepositorio
				: path.join(packageRoot, "node_modules/@mercuryworkshop/libcurl-transport/dist")
		)
	);

	app.use(express.static(path.join(__dirname, "public")));

	app.listen(PORT, () => {
		console.log(`    Harness server listening on port ${PORT}`);
	});

	const wispServer = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("wisp server");
	});
	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(logging.NONE);

	wispServer.on("upgrade", (req, socket, head) => {
		wisp.routeRequest(req, socket, head);
	});

	wispServer.listen(WISP_PORT, () => {
		console.log(`    Wisp server listening on port ${WISP_PORT}`);
	});
}
