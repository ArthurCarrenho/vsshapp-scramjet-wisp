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
  // vssh fork: the ceiling of the connection phase of each request (the wisp CONNECT, the server's
  // TCP connection and the TLS handshake), in ms. Without it, the 15 s compiled into libcurl.
  connectTimeoutMs?: number;
};

// vssh fork: what the wisp connection of this transport looks like now, read without sending
// anything. `lastPacketAgoMs` is null when no packet has arrived yet.
export type WispState = {
  connected: boolean;
  lastPacketAgoMs: number | null;
  openStreams: number;
};

// vssh fork: the health of the link that this transport measures on its own traffic. `state` is
// "degraded" when the TLS handshakes of the last requests are slow or when connections are failing
// for lack of an answer, the two marks a link losing packets leaves; "ok" otherwise, and "unknown"
// before there is enough to say.
export type LinkHealth = {
  state: "ok" | "degraded" | "unknown";
  handshakeMs: number | null;
  ttfbMs: number | null;
  failures: number;
  samples: number;
};

// vssh fork: the wisp close reasons that name the failure of a connection. The server sends them
// in the CLOSE packet (backend/motivos.js), and the wisp client of libcurl.js keeps the last one per
// host and port. 0x90 is the client's own: the wisp WebSocket closed under the stream.
export const WISP_REASONS: Record<number, string> = {
  0x03: "network",
  0x42: "dns",
  0x43: "no_response",
  0x44: "refused",
  0x47: "idle",
  0x48: "blocked",
  0x49: "throttled",
  0x61: "dns_no_response",
  0x90: "wisp_closed",
};

// vssh fork: what certificateOf() answers. `certs` are the PEMs the server sent, from the leaf on;
// `verifyFlags` are the MBEDTLS_X509_BADCERT_* bits (libcurl.js maps BoringSSL's verify result onto
// them, since the shell reads these bits) for that chain against the CA bundle and the host name,
// and 0 means it verifies.
export type CertificateReport = {
  verified: boolean;
  verifyFlags: number;
  certs: string[];
  tls: { version?: string; cipher?: string };
};
// vssh fork: the curl-impersonate profile for the browser a request says it comes from. Cloudflare
// and the other bot screens compare the User-Agent with the TLS ClientHello and the HTTP/2 frames,
// and a Chrome User-Agent over a connection that looks like curl is the challenge that comes back
// after it is solved. The profile gives the connection the shape of that browser family; the header
// values stay the page's own. An agent none of these match keeps curl's own connection.
export function browserProfile(userAgent: string | undefined): string | undefined {
  const ua = userAgent || "";
  if (/Firefox\//.test(ua)) return "firefox155";
  if (/Chrome\/|Chromium\/|CriOS\/|Edg\//.test(ua)) return /Android/.test(ua) ? "chrome131_android" : "chrome152";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return /iPhone|iPad|iPod/.test(ua) ? "safari270_ios" : "safari270";
  return undefined;
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  for (const k in headers) if (k.toLowerCase() === name) return headers[k];
  return undefined;
}

// The User-Agent the request will leave with. A service worker never sees the browser's own
// User-Agent among a request's headers (the network layer adds it below fetch), so most requests
// reach the transport without one, and libcurl.js fills in navigator.userAgent on its own side. The
// profile has to follow the same value, or those requests would leave with curl's ClientHello under
// a Chrome User-Agent.
function userAgentOf(headers: Record<string, string>): string | undefined {
  return headerOf(headers, "user-agent") ?? (globalThis as any).navigator?.userAgent;
}

// vssh fork: the `priority` header a browser sends on a navigation. The page never sees it (the
// browser adds it below fetch), so it does not reach the transport, and a navigation without it
// is one more mark of a client that is not the browser it claims to be. The value is the one
// Chrome, Firefox and Safari send for a top-level document or a frame.
function withNavigationPriority(headers: Record<string, string>): Record<string, string> {
  const destino = headerOf(headers, "sec-fetch-dest");
  if ((destino === "document" || destino === "iframe") && headerOf(headers, "priority") === undefined)
    return { ...headers, priority: "u=0, i" };
  return headers;
}

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
  connectTimeoutMs?: number;
  // vssh fork: the samples behind health(), newest last. Each one is a request that got its
  // headers on a NEW connection (a reused one has no handshake to measure), or a failure.
  private amostras: Array<{ em: number; handshakeMs?: number; ttfbMs?: number; falha?: boolean }> = [];

  constructor(options: LibcurlClientOptions) {
    this.wisp = options.wisp ?? options.websocket;
    this.transport = options.transport;
    this.proxy = options.proxy;
    this.connections = options.connections;
    this.insecure = options.insecure;
    this.wasmUrl = options.wasm ?? WASM_PADRAO;
    this.connectTimeoutMs = options.connectTimeoutMs;
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

  // vssh fork: a failed request carries the reason the wisp server gave for the connection, when
  // one closed for this host and port since the request started. The reason travels in the
  // message, as "[wisp 0x42]", because the error crosses to the service worker as text; the page
  // of error reads it there. Timeouts and failures for lack of an answer also count for health().
  private comMotivo(e: any, remote: URL, desde: number) {
    if (!(e instanceof Error) || !/error code (\d+)/.test(e.message)) return e;
    const codigo = Number(/error code (\d+)/.exec(e.message)![1]);
    const porta = Number(remote.port) || (remote.protocol === "https:" || remote.protocol === "wss:" ? 443 : 80);
    const motivo = libcurl.wisp?.reason_of?.(remote.hostname, porta, desde);
    if (codigo === 28 || motivo === 0x43 || motivo === 0x61 || motivo === 0x90) this.anotar({ falha: true });
    if (!motivo) return e;
    const novo = new TypeError(`${e.message} [wisp 0x${motivo.toString(16).padStart(2, "0")}]`);
    (novo as any).wispReason = motivo;
    return novo;
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

  // vssh fork: changes the connection-phase ceiling of the requests that start from now on.
  // `undefined` goes back to the one compiled into libcurl.
  setConnectTimeout(ms: number | undefined) {
    this.connectTimeoutMs = Number.isFinite(ms) && (ms as number) > 0 ? Math.round(ms as number) : undefined;
  }

  // vssh fork: the wisp connection this transport uses, read from what it already received. A
  // connection that got a packet a moment ago is alive, and asking it something to find out would
  // only add a request to a link that may already be slow.
  wispState(): WispState {
    const connections = libcurl.wisp?.wisp_connections;
    let estado: WispState = { connected: false, lastPacketAgoMs: null, openStreams: 0 };
    if (!connections) return estado;
    for (const [url, c] of Object.entries<any>(connections)) {
      if (!url.startsWith(this.wisp)) continue;
      const ultimo = Number(c.last_packet_at) || 0;
      estado = {
        connected: !!c.connected,
        lastPacketAgoMs: ultimo ? Math.max(0, Math.round(performance.now() - ultimo)) : null,
        openStreams: Object.keys(c.active_streams || {}).length,
      };
    }
    return estado;
  }

  // vssh fork: the link health measured on the last two minutes of this transport's requests.
  health(): LinkHealth {
    const agora = performance.now();
    this.amostras = this.amostras.filter((a) => agora - a.em < 120_000).slice(-40);
    const mediana = (v: number[]) => {
      if (!v.length) return null;
      const o = [...v].sort((a, b) => a - b);
      const m = o.length >> 1;
      return o.length % 2 ? o[m] : Math.round((o[m - 1] + o[m]) / 2);
    };
    const handshakes = this.amostras.filter((a) => a.handshakeMs != null).slice(-10).map((a) => a.handshakeMs!);
    const ttfbs = this.amostras.filter((a) => a.ttfbMs != null).slice(-10).map((a) => a.ttfbMs!);
    const falhas = this.amostras.filter((a) => a.falha && agora - a.em < 60_000).length;
    const handshakeMs = mediana(handshakes);
    const samples = handshakes.length + falhas;
    // A TLS 1.3 handshake costs one round trip to the site plus the wisp hop. Three seconds of
    // median over several new connections does not happen on a healthy link, however far the site
    // is: it is retransmission. Two connections failing for lack of an answer in a minute is the
    // other mark, and it shows up even when nothing completes.
    let state: LinkHealth["state"] = "unknown";
    if (falhas >= 2 || (handshakes.length >= 3 && (handshakeMs as number) > 3000)) state = "degraded";
    else if (handshakes.length >= 3) state = "ok";
    return { state, handshakeMs, ttfbMs: mediana(ttfbs), failures: falhas, samples };
  }

  private anotar(amostra: { handshakeMs?: number; ttfbMs?: number; falha?: boolean }) {
    this.amostras.push({ em: performance.now(), ...amostra });
    if (this.amostras.length > 80) this.amostras.splice(0, this.amostras.length - 40);
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
    const perfil = browserProfile(userAgentOf(headersObj));
    if (perfil) headersObj = withNavigationPriority(headersObj);
    const inicio = Date.now();
    let payload;
    try {
      payload = await this.session.fetch(remote.href, {
        method,
        headers: headersObj,
        body,
        redirect: "manual",
        signal: signal,
        insecure: this.insecure || this.insecureHosts.has(remote.host.toLowerCase()),
        _vssh_impersonate: perfil,
        ...(this.connectTimeoutMs ? { _vssh_connect_timeout_ms: this.connectTimeoutMs } : {}),
      });
    } catch (e: any) {
      throw this.comMotivo(e, remote, inicio);
    }
    const t = payload?.timing;
    if (t && !t.reused && t.tls_us > 0) {
      this.anotar({
        handshakeMs: Math.round((t.tls_us - t.connect_us) / 1000),
        ttfbMs: Math.round((t.ttfb_us - t.tls_us) / 1000),
      });
    }

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
      impersonate: browserProfile(userAgentOf(headersObj)),
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
