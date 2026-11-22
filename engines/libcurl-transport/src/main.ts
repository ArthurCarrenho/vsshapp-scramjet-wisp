import type {
  RawHeaders,
  TransferrableResponse,
  ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
// vssh fork: the vendored build of libcurl.js from engines/libcurl.js (lib/libcurl.mjs), with the
// WASM in its own file (lib/libcurl.wasm), which the bundle step copies next to dist/index.js.
// esbuild inlines the JS glue into dist/, so the runtime never resolves libcurl.js.
//
// The WASM travels apart from the JS so that the browser compiles it while it downloads
// (WebAssembly.instantiateStreaming) and keeps the compiled code between page loads. Embedded as
// base64 in the JS, it was decoded and compiled again on every load of the shell.
// @ts-ignore
import { libcurl } from "../lib/libcurl.mjs";

// Where the WASM is when nobody says: next to the script that is running now. The UMD bundle runs
// from a <script>, and document.currentScript is only set while it evaluates, so it is read here,
// at the top of the module, and not in init().
const WASM_PADRAO: string | undefined = (() => {
  try {
    const src = (globalThis as any).document?.currentScript?.src;
    return src ? new URL("libcurl.wasm", src).href : undefined;
  } catch {
    return undefined;
  }
})();

// load_wasm() starts a second instantiation if it is called again before the first one ends, so
// every client of this page waits on the same load.
let carga: Promise<void> | null = null;

export type LibcurlClientOptions = {
  wisp: string;
  websocket?: string;
  proxy?: string;
  transport?: string;
  connections?: Array<number>;
  // vssh fork: skip TLS peer/host verification (self-signed certs on internal/dev
  // servers) for every host, on HTTP(S) requests and on proxied WebSocket connections. For a
  // single host, see setInsecureHosts().
  insecure?: boolean;
  // vssh fork: the URL of libcurl.wasm. Without it, the file next to the script that loaded this
  // bundle.
  wasm?: string;
};

// vssh fork: what certificateOf() answers. `certs` are the PEMs the server sent, from the leaf on;
// `verifyFlags` are mbedtls' MBEDTLS_X509_BADCERT_* flags for that chain against the CA bundle and
// the host name, and 0 means it verifies.
export type CertificateReport = {
  verified: boolean;
  verifyFlags: number;
  certs: string[];
  tls: { version?: string; cipher?: string };
};
export default class LibcurlClient implements ProxyTransport {
  session: any;
  wisp: string;
  proxy?: string;
  transport?: string;
  connections?: Array<number>;
  insecure?: boolean;
  wasmUrl?: string;
  // vssh fork: the hosts (URL.host, with the port when it is not the default) whose
  // certificate the person accepted on the TLS error page. libcurl reads `insecure` per
  // request, and curl only reuses a connection whose TLS settings match, so a connection
  // opened without verification never carries a request to another host.
  insecureHosts: Set<string> = new Set();

  constructor(options: LibcurlClientOptions) {
    this.wisp = options.wisp ?? options.websocket;
    this.transport = options.transport;
    this.proxy = options.proxy;
    this.connections = options.connections;
    this.insecure = options.insecure;
    this.wasmUrl = options.wasm ?? WASM_PADRAO;
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
      if (!this.wasmUrl) throw new TypeError("libcurl.wasm: pass the `wasm` option with its URL.");
      carga ??= Promise.resolve(libcurl.load_wasm(this.wasmUrl)).catch((e: unknown) => {
        carga = null;
        throw e;
      });
      await carga;
      console.log("loaded libcurl.js v" + libcurl.version.lib);
      this.ready = true;
    }

    this.discardWispConnection();
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

  // vssh fork: libcurl.js keeps one WispConnection per wisp URL in a module-level map
  // (`libcurl.wisp.wisp_connections`) and hands it to every new socket until it emits close or
  // error. A WebSocket that goes silent without closing (a NAT or a load balancer that forgot
  // the pair) emits neither, so the HTTPSession that init() creates would open its streams on
  // the same dead connection, and a caller that re-runs init() to recover never gets a new one.
  // init() drops whatever connection the map holds for this URL, and the new session opens its
  // own.
  //
  // The old connection fails its streams at once and tells its WispWebSockets, whose close
  // listener deletes the map entry by URL. After that it stops dispatching: the browser fires
  // the socket's own close event much later, when the map already holds the new connection, and
  // the same listener would delete that one.
  private discardWispConnection() {
    const connections = libcurl.wisp?.wisp_connections;
    if (!connections) return;
    for (const [url, connection] of Object.entries<any>(connections)) {
      if (!url.startsWith(this.wisp)) continue;
      try { connection.on_ws_close?.(); } catch { }
      try { connection.dispatchEvent(new CloseEvent("close")); } catch { }
      connection.dispatchEvent = () => true;
      delete connections[url];
      try { connection.ws?.close(); } catch { }
    }
  }

  // vssh fork: replaces the set of hosts requested without TLS verification. The shell
  // detects this method by name, and an older transport without it keeps verifying every
  // host that the global `insecure` flag does not cover.
  setInsecureHosts(hosts: Iterable<string>) {
    this.insecureHosts = new Set(Array.from(hosts, (h) => String(h).toLowerCase()));
  }

  // vssh fork: the certificate of a site, read by the same libcurl, CA bundle and wisp exit that
  // carry its pages: a GET on a new connection and a new TLS session, since libcurl only fills the
  // chain while the certificates are exchanged, aborted as soon as the headers arrive. A HEAD would
  // not do: its transfer ends with the headers, and libcurl has already let go of the TLS session
  // when they are read. The request itself skips verification so that the chain arrives even from
  // a server that would be refused, and libcurl checks it afterwards with the profile curl uses.
  // Rejects when no connection could be made at all.
  async certificateOf(url: string): Promise<CertificateReport> {
    const parar = new AbortController();
    const r = await this.session.fetch(url, {
      redirect: "manual",
      credentials: "omit",
      signal: parar.signal,
      _vssh_certinfo: true,
    });
    parar.abort();
    const flags = Number(r?.tls?.verify_flags);
    return {
      verified: flags === 0,
      verifyFlags: Number.isFinite(flags) ? flags : -1,
      certs: Array.isArray(r?.certinfo) ? r.certinfo : [],
      tls: { version: r?.tls?.version, cipher: r?.tls?.cipher },
    };
  }

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
      insecure: this.insecure || this.insecureHosts.has(remote.host.toLowerCase()),
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
      insecure: this.insecure || this.insecureHosts.has(url.host.toLowerCase()),
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
