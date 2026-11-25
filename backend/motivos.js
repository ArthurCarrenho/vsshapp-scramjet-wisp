// O motivo com que o servidor fecha uma stream wisp, e o que cada um quer dizer para o navegador.
//
// O protocolo wisp tem um byte de motivo no pacote CLOSE, e o wisp-js fecha com `NetworkError`
// (0x03) toda stream cuja conexão não abriu, seja qual for a causa (`connection.mjs`,
// `create_stream`). Do lado do navegador o libcurl só vê o socket fechar e devolve o código 7, "não
// conectou", e a página de erro dizia "recusou a conexão" para um nome que não resolveu, para um
// destino que a régua barrou e para um servidor que não respondeu. O motivo certo existe aqui, no
// servidor, e só aqui.
//
// O socket de cada stream (`tcp.js`) anota o motivo da falha em `socket.motivo`, e o
// `close_stream` da conexão troca o `NetworkError` genérico pelo anotado. Um fechamento com outro
// motivo (o `Voluntary` do fim normal, o `ConnThrottled` do teto de streams) passa como veio.
//
// Os códigos 0x41 a 0x49 são os do protocolo. Os de 0x60 em diante são deste motor, e o cliente
// wisp do libcurl.js deste repositório os conhece; um cliente que não os conheça os trata como
// qualquer fechamento com erro.

export const MOTIVO = Object.freeze({
  NetworkError:    0x03, // a conexão caiu, ou não abriu por um motivo sem nome
  UnreachableHost: 0x42, // o nome não existe (NXDOMAIN) ou o endereço não tem rota
  NoResponse:      0x43, // o destino não respondeu ao SYN no prazo do servidor
  ConnRefused:     0x44, // o destino respondeu com RST
  TransferTimeout: 0x47, // a conexão ficou parada além do prazo de inatividade
  HostBlocked:     0x48, // a régua de rede do motor recusou o destino
  ConnThrottled:   0x49, // o teto de streams da conexão
  DnsSemResposta:  0x61, // o resolvedor do servidor não respondeu (EAI_AGAIN, timeout): o link, e não o nome
});

/** O motivo wisp de um erro de conexão ou de resolução, pelo `code` do Node. */
export function motivoDoErro(erro) {
  const code = erro?.code || '';
  if (erro?.motivo === 'recusado' || erro?.name === 'DestinoRecusado') return MOTIVO.HostBlocked;
  switch (code) {
    case 'ENOTFOUND':
    case 'ENODATA':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return MOTIVO.UnreachableHost;
    case 'EAI_AGAIN':
    case 'ETIMEOUT':
    case 'ESERVFAIL':
    case 'ECONNREFUSED_DNS':
      return MOTIVO.DnsSemResposta;
    case 'ETIMEDOUT':
    case 'ECONNTIMEOUT':
      return MOTIVO.NoResponse;
    case 'ECONNREFUSED':
      return MOTIVO.ConnRefused;
    default:
      return MOTIVO.NetworkError;
  }
}

/** O nome curto do motivo, para o log e para as métricas. */
export function nomeDoMotivo(motivo) {
  switch (motivo) {
    case MOTIVO.UnreachableHost: return 'dns';
    case MOTIVO.DnsSemResposta:  return 'dns_sem_resposta';
    case MOTIVO.NoResponse:      return 'sem_resposta';
    case MOTIVO.ConnRefused:     return 'recusada';
    case MOTIVO.HostBlocked:     return 'bloqueada';
    case MOTIVO.ConnThrottled:   return 'limite';
    case MOTIVO.TransferTimeout: return 'ociosa';
    default:                     return 'rede';
  }
}

/**
 * Ensina o `close_stream` do wisp-js a usar o motivo que o socket anotou. Idempotente: a classe é
 * do pacote e única no processo, e uma segunda chamada não embrulha duas vezes.
 */
export function instalarMotivos(wisp) {
  const proto = wisp.ServerConnection?.prototype;
  if (!proto || proto.close_stream.__comMotivo) return;
  const original = proto.close_stream;
  const comMotivo = function (streamId, motivo = null, quieto = false) {
    const anotado = this.streams?.[streamId]?.socket?.motivo;
    if (anotado && (motivo === MOTIVO.NetworkError || motivo === 0x02 /* Voluntary */)) motivo = anotado;
    return original.call(this, streamId, motivo, quieto);
  };
  comMotivo.__comMotivo = true;
  proto.close_stream = comMotivo;
}
