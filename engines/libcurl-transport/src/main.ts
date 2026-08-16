import type {
  RawHeaders,
  TransferrableResponse,
  ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
// vssh fork: import the vendored, patched single-file build of libcurl.js (lib/
// libcurl_full.mjs) instead of the upstream "libcurl.js/bundled" package. That build
// includes the CURLOPT_SSL_VERIFYPEER/VERIFYHOST opt-out (the "insecure" option below)
// and is produced by the ArthurCarrenho/vssh-libcurl.js fork's CI. esbuild inlines this
// file (with its embedded WASM) into dist/, so the runtime never resolves libcurl.js.
// @ts-ignore
import { libcurl } from "../lib/libcurl_full.mjs";

export type LibcurlClientOptions = {
  wisp: string;
  websocket?: string;
  proxy?: string;
  transport?: string;
  connections?: Array<number>;
  // vssh fork: skip TLS peer/host verification (self-signed certs on internal/dev
  // servers). Applies to HTTP(S) requests via HTTPSession; not to WebSocket connections.
  insecure?: boolean;
};
export default class LibcurlClient implements ProxyTransport {
  session: any;
  wisp: string;
  proxy?: string;
  transport?: string;
  connections?: Array<number>;
  insecure?: boolean;

  constructor(options: LibcurlClientOptions) {
    this.wisp = options.wisp ?? options.websocket;
    this.transport = options.transport;
    this.proxy = options.proxy;
    this.connections = options.connections;
    this.insecure = options.insecure;
    if (!this.wisp.endsWith("/")) {
      throw new TypeError(
        "The Websocket URL must end with a trailing forward slash."
      );
    }
    if (!this.wisp.startsWith("ws://") && !this.wisp.startsWith("wss://")) {
      throw new TypeError(
        "The Websocket URL must use the ws:// or wss:// protocols."
      );
    }
    if (typeof options.proxy === "string") {
      let protocol = new URL(options.proxy).protocol;
      if (!["socks5h:", "socks4a:", "http:"].includes(protocol)) {
        throw new TypeError(
          "Only socks5h, socks4a, and http proxies are supported."
        );
      }
    }
  }

  async init() {
    if (this.transport) libcurl.transport = this.transport;
    if (!libcurl.ready) {
      await new Promise((resolve, reject) => {
        libcurl.onload = () => {
          console.log("loaded libcurl.js v" + libcurl.version.lib);
          this.ready = true;
          resolve(null);
        };
      });
    }

    libcurl.set_websocket(this.wisp);
    this.session = new libcurl.HTTPSession({
      proxy: this.proxy,
      insecure: this.insecure,
    });

    if (this.connections) this.session.set_connections(...this.connections);

    this.ready = libcurl.ready;
    if (this.ready) {
      console.log("running libcurl.js v" + libcurl.version.lib);
      return;
    }
  }
  ready = false;
  async meta() { }

  async request(
    remote: URL,
    method: string,
    body: BodyInit | null,
    headers: RawHeaders,
    signal: AbortSignal | undefined
  ): Promise<TransferrableResponse> {
    let headersObj: Record<string, string> = {};
    for (let [key, value] of headers) {
      headersObj[key] = value;
    }
    let payload = await this.session.fetch(remote.href, {
      method,
      headers: headersObj,
      body,
      redirect: "manual",
      signal: signal,
    });

    return {
      body: payload.body!,
      headers: payload.raw_headers,
      status: payload.status,
      statusText: payload.statusText,
    };
  }

  connect(
    url: URL,
    protocols: string[],
    requestHeaders: RawHeaders,
    onopen: (protocol: string, extensions: string) => void,
    onmessage: (data: Blob | ArrayBuffer | string) => void,
    onclose: (code: number, reason: string) => void,
    onerror: (error: string) => void
  ): [
      (data: Blob | ArrayBuffer | string) => void,
      (code: number, reason: string) => void,
    ] {
    let headersObj: Record<string, string> = {};
    for (let [key, value] of requestHeaders) {
      headersObj[key] = value;
    }

    let socket = new libcurl.WebSocket(url.toString(), protocols, {
      headers: headersObj,
    });

    socket.binaryType = "arraybuffer";

    socket.onopen = (event: Event) => {
      onopen("", "");
    };
    socket.onclose = (event: CloseEvent) => {
      onclose(event.code, event.reason);
    };
    socket.onerror = (event: Event) => {
      onerror("");
    };
    socket.onmessage = (event: MessageEvent) => {
      onmessage(event.data);
    };

    return [
      (data) => {
        socket.send(data);
      },
      (code, reason) => {
        socket.close(code, reason);
      },
    ];
  }
}

export { LibcurlClient };
