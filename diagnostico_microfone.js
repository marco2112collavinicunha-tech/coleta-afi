/**
 * Diagnóstico do microfone: confere se o navegador atendeu ao pedido de captura
 * sem processamento.
 *
 * `captura.js` pede `echoCancellation`, `noiseSuppression` e `autoGainControl` =
 * false; esta tela lê de volta o que o navegador aplicou. O iOS pode não
 * atender ao pedido. Sem esta leitura, o teste num aparelho responde só metade da
 * pergunta: o áudio muda, mas não se sabe se foi o navegador que ligou o controle
 * de ganho.
 *
 * Só para engenharia (`ENG###`). `P###` é recusado antes de abrir o microfone:
 * a família nunca vê esta tela, e a página das famílias (`index.html`) não muda.
 *
 * Nada é gravado nem enviado. A tela lê as configurações da faixa de áudio,
 * mostra, e fecha o microfone.
 *
 * O que esta tela não responde: se o aparelho processa o som antes do navegador
 * (no sistema ou no hardware). Isso só um teste que grava um sinal de nível
 * conhecido pelo aparelho e compara o nível gravado responde.
 */
import { FLAGS_DE_CAPTURA } from "./captura.js";
import { ehEngenharia } from "./trava_de_participante.js";

export const BANDEIRAS = ["echoCancellation", "noiseSuppression", "autoGainControl"];

export const NOMES_DAS_BANDEIRAS = {
  echoCancellation: "cancelamento de eco",
  noiseSuppression: "supressão de ruído",
  autoGainControl: "controle automático de ganho",
};

export const RECUSA_PARA_PARTICIPANTE =
  "Esta tela é só para testes de engenharia (código ENG###).";

// Três estados, e não dois. "não informado" não é "igual": o iOS costuma
// omitir as bandeiras em getSettings(), e ausência de resposta não confirma
// que o pedido foi atendido.
export const IGUAL = "igual";
export const DIVERGENTE = "divergente";
export const NAO_INFORMADO = "nao_informado";

export function podeAbrirDiagnostico(pessoa) {
  return ehEngenharia(pessoa);
}

// deviceId é longo e muda por origem; basta o começo para distinguir aparelhos
// na foto. Não é identificador de pessoa.
export function resumirDeviceId(id) {
  const texto = String(id || "");
  if (!texto) return "(não informado)";
  if (texto === "default") return "default";
  return texto.length <= 8 ? texto : texto.slice(0, 8) + "…";
}

export function compararBandeiras(pedido, aplicado) {
  const lido = aplicado || {};
  return BANDEIRAS.map((chave) => {
    const valor = lido[chave];
    let estado;
    if (typeof valor !== "boolean") estado = NAO_INFORMADO;
    else estado = valor === pedido[chave] ? IGUAL : DIVERGENTE;
    return {
      chave,
      nome: NOMES_DAS_BANDEIRAS[chave],
      pedido: pedido[chave],
      aplicado: typeof valor === "boolean" ? valor : null,
      estado,
    };
  });
}

/**
 * @param {object} p
 * @param {string} p.pessoa        código do link (`?p=`); só `ENG###` passa
 * @param {object} [p.pedido]      o que a página pede (padrão: FLAGS_DE_CAPTURA)
 * @param {object|null} p.aplicado o que `track.getSettings()` devolveu
 * @param {number} [p.taxaDoContexto] `AudioContext.sampleRate`: é a taxa do WAV
 * @param {string} [p.userAgent]
 */
export function montarDiagnostico({ pessoa, pedido = FLAGS_DE_CAPTURA, aplicado,
                                    taxaDoContexto, userAgent }) {
  if (!podeAbrirDiagnostico(pessoa)) throw new Error(RECUSA_PARA_PARTICIPANTE);
  const lido = aplicado || {};
  const bandeiras = compararBandeiras(pedido, lido);
  const divergentes = bandeiras.filter((b) => b.estado === DIVERGENTE);
  const naoInformadas = bandeiras.filter((b) => b.estado === NAO_INFORMADO);
  const avisos = [];
  for (const b of divergentes) {
    avisos.push(`DIVERGE: pedido ${b.nome} = ${b.pedido}, o navegador aplicou ${b.aplicado}`);
  }
  for (const b of naoInformadas) {
    avisos.push(`NÃO INFORMADO: o navegador não disse se aplicou ${b.nome} ` +
      "(ausência não confirma o pedido)");
  }
  if (!aplicado) avisos.unshift("o navegador não tem getSettings(): nada foi lido");
  return {
    pessoa,
    bandeiras,
    divergencias: divergentes.length,
    nao_informadas: naoInformadas.length,
    tudo_confere: divergentes.length === 0 && naoInformadas.length === 0,
    avisos,
    sampleRate: typeof lido.sampleRate === "number" ? lido.sampleRate : null,
    taxa_do_contexto: typeof taxaDoContexto === "number" ? taxaDoContexto : null,
    channelCount: typeof lido.channelCount === "number" ? lido.channelCount : null,
    deviceId: resumirDeviceId(lido.deviceId),
    userAgent: String(userAgent || ""),
  };
}

// Lê a primeira faixa de áudio do fluxo. Sem `getSettings` devolve null, e o
// diagnóstico diz isso em vez de supor.
export function lerAplicado(fluxo) {
  const faixa = fluxo && fluxo.getAudioTracks ? fluxo.getAudioTracks()[0] : null;
  if (!faixa || typeof faixa.getSettings !== "function") return null;
  return faixa.getSettings() || {};
}
