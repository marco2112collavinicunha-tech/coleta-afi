// Captura de áudio da página de coleta: abre o microfone, grava quadros crus
// pela Web Audio API, escreve o WAV PCM 16 bits e envia a gravação ao receptor.
//
// A página não usa MediaRecorder. Ele entrega o áudio já codificado (em geral,
// opus), com codec escolhido pelo navegador e diferente entre aparelhos. A
// compressão com perda e a compressão de faixa dinâmica alteram a envoltória
// de amplitude, da qual o índice de variabilidade é calculado. Gravar quadros
// crus e escrever o WAV aqui mantém o sinal sob controle.
//
// O cabeçalho WAV é escrito à mão. O receptor lê cada arquivo com soundfile e
// recusa o que não for legível, o que protege contra erro nesse cabeçalho.

import { ritmoSemValorFixado } from "./trava_de_participante.js";

// Pedidas ao getUserMedia, antes de qualquer gravação (pré-registro, campo 11).
// O iOS pode não atendê-las. O pedido continua correto onde o navegador o
// honra.
export const FLAGS_DE_CAPTURA = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

// Pré-rolagem: a gravação começava 1 s antes de o estímulo aparecer, com a
// tela vazia, para que o silêncio inicial tivesse duração conhecida e nenhum
// movimento de busca articulatória pudesse começar antes de PRE_ROLAGEM_MS.
// Esse desenho supunha que a pessoa ainda não tinha visto o que dizer.
//
// Desde 08/10/2026 (decisão do pesquisador, 05h41 a 05h46: fluxo em dois
// toques, Ouvir e depois Gravar) a pessoa já ouviu a frase-modelo quando a
// família toca em Gravar, e pode começar a falar a qualquer momento; a
// pré-rolagem não garantia mais silêncio inicial (o campo 11 do pré-registro
// já declarava isso). A análise do início não depende dela: o que
// `inconsistencia/onset.py` (onset_por_consenso) exige a montante é o corte de
// silêncio por energia (src/preprocess.py, cortar_silencio), que remove o
// silêncio inicial de qualquer duração; nenhum módulo de análise lê
// `pre_rolagem_ms`, que é só descrição da tomada no sidecar. Por isso o
// valor passou a 0: a gravação começa no toque em Gravar e os pictogramas não
// saem da tela. O mecanismo (`gravadorComPreRolagem`) e o campo do envio
// continuam, para que gravações antigas (1 s) e novas (0) sejam distinguíveis.
// O que substitui a duração conhecida do silêncio é o intervalo medido entre o
// fim da frase-modelo e o toque em Gravar (`iniciarTomada`).
//
// Cauda: com a chave `CAUDA_APOS_PARAR` da página ligada, a gravação continua
// CAUDA_MS depois do toque em Parar (`pararComCauda`), porque a família tende a
// tocar Parar colado ao fim da fala e o fim da produção pode ficar de fora. A
// cauda só acrescenta áudio; não corta nada. Ligada em 08/10/2026 com 500 ms
// (decisão do pesquisador, 05h41 a 05h46); a tela mostra "Gravando..." durante
// a cauda. O corte de silêncio da análise continua depois.
export const PRE_ROLAGEM_MS = 0;
export const CAUDA_MS = 500;

export async function abrirMicrofone() {
  const fluxo = await navigator.mediaDevices.getUserMedia({ audio: FLAGS_DE_CAPTURA });
  const contexto = new (window.AudioContext || window.webkitAudioContext)();
  return { fluxo, contexto, taxa: contexto.sampleRate };
}

// Grava até `parar()` ser chamado. Devolve os quadros crus, sem processamento.
export function gravador(fluxo, contexto) {
  const fonte = contexto.createMediaStreamSource(fluxo);
  const no = contexto.createScriptProcessor(4096, 1, 1);
  const blocos = [];
  no.onaudioprocess = (evento) => {
    // O navegador reutiliza o buffer do evento; por isso a cópia.
    blocos.push(new Float32Array(evento.inputBuffer.getChannelData(0)));
  };
  fonte.connect(no);
  no.connect(contexto.destination);
  return {
    parar() {
      no.disconnect();
      fonte.disconnect();
      const total = blocos.reduce((n, b) => n + b.length, 0);
      const tudo = new Float32Array(total);
      let i = 0;
      for (const b of blocos) { tudo.set(b, i); i += b.length; }
      return tudo;
    },
  };
}

// Começa a gravar, espera `preRolagemMs` e só então chama `mostrarEstimulo()`.
// A pré-rolagem permanece no áudio e vai marcada no envio, para que a análise
// saiba onde termina o silêncio de duração conhecida.
//
// A pré-rolagem medida vai do início da gravação até o instante em que o
// estímulo é mostrado, no relógio do AudioContext (o mesmo que conta o áudio
// gravado). Ela é fixada quando o estímulo aparece, não em `parar()`: medida em
// `parar()`, seria a duração inteira da tomada. Se a tomada parar antes de o
// estímulo aparecer, não houve fim de pré-rolagem a medir, e o campo vai `null`
// ao lado do nominal. O AudioContext pode começar suspenso e demorar a contar;
// então o valor medido pode ficar abaixo do tempo de relógio decorrido.
export function gravadorComPreRolagem(fluxo, contexto, mostrarEstimulo,
                                      preRolagemMs = PRE_ROLAGEM_MS) {
  const base = gravador(fluxo, contexto);
  const comecou = contexto.currentTime;
  let medida = null;
  const prometido = new Promise((resolver) => {
    setTimeout(() => {
      medida = Math.round((contexto.currentTime - comecou) * 1000);
      mostrarEstimulo();
      resolver();
    }, preRolagemMs);
  });
  return {
    estimuloMostrado: prometido,
    parar() {
      const amostras = base.parar();
      return {
        amostras,
        // O valor nominal e o medido podem diferir: `setTimeout` não é pontual
        // e o AudioContext pode demorar a iniciar. Os dois são enviados.
        pre_rolagem_ms: preRolagemMs,
        pre_rolagem_medida_ms: medida,
      };
    },
  };
}

// Para a gravação só depois de `caudaMs`, e mede a cauda efetiva: do toque em
// Parar até o fim da captura. `setTimeout` não é pontual, por isso o valor
// medido vai no envio ao lado do nominal. `esperar` e `agora` são injetáveis
// para os testes.
export async function pararComCauda(gravando, caudaMs = CAUDA_MS,
                                    { esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
                                      agora = () => Date.now() } = {}) {
  const tocouParar = agora();
  await esperar(caudaMs);
  const resultado = gravando.parar();
  return { ...resultado, cauda_ms: caudaMs,
           cauda_medida_ms: Math.round(agora() - tocouParar) };
}

// Saturação: o teto é o maior valor que o WAV de 16 bits representa. Uma
// amostra com módulo igual ou acima dele foi ceifada (ou está no limite), e a
// forma de onda perde o pico. Devolve o pico (módulo máximo, em escala de 0 a
// 1) e a fração das amostras no teto; a decisão (aviso, exclusão) fica com
// quem chama.
export const TETO_DE_AMOSTRA = 32767 / 32768;

export function medirSaturacao(amostras) {
  let pico = 0, noTeto = 0;
  for (let i = 0; i < amostras.length; i++) {
    const v = Math.abs(amostras[i]);
    if (v > pico) pico = v;
    if (v >= TETO_DE_AMOSTRA) noTeto += 1;
  }
  return { pico: Math.min(pico, 1),
           fracao_no_teto: amostras.length ? noTeto / amostras.length : 0 };
}

// ---------------------------------------------------------------------------
// Ambiente da sessão: medido uma vez, na abertura de cada sessão.
//
// Com a chave `AMBIENTE_NA_SESSAO` da página ligada, antes da primeira gravação
// da sessão a página grava SILENCIO_DE_ABERTURA_MS de silêncio e monta uma
// ficha com três coisas: o nível do ruído de fundo, as configurações que o
// navegador aplicou ao microfone e a classe da entrada de áudio (Bluetooth ou
// não). A ficha vai em todos os envios da sessão, para descrição e análise de
// sensibilidade. Nada nela recusa gravação nem exclui participante: os avisos
// são só texto na tela, e a sessão segue igual com ou sem eles.
//
// Privacidade: o rótulo do dispositivo pode trazer o nome do dono ("AirPods de
// ..."). Ele é lido, classificado e descartado aqui dentro; a ficha só leva a
// classe. `deviceId` e `groupId` também ficam fora: são identificadores estáveis
// do aparelho por origem.
export const SILENCIO_DE_ABERTURA_MS = 3000;

// Limiar do aviso de ruído alto, em dBFS RMS. Sem valor de propósito: o nível
// que atrapalha a medida ainda não foi medido nem escolhido, e um número posto
// aqui pareceria critério. Enquanto for `null`, o ruído é medido e registrado,
// e o aviso não aparece.
export const LIMIAR_DE_RUIDO_DE_FUNDO_DBFS = null;

// As configurações lidas de `track.getSettings()`. Só estas; o resto (em
// especial `deviceId` e `groupId`) não entra na ficha.
export const CONFIGURACOES_BOOLEANAS = ["echoCancellation", "noiseSuppression",
                                        "autoGainControl"];
export const CONFIGURACOES_NUMERICAS = ["sampleRate", "channelCount", "sampleSize",
                                        "latency"];

export const ENTRADA_BLUETOOTH = "bluetooth";
export const ENTRADA_NAO_BLUETOOTH = "nao_bluetooth";
export const ENTRADA_ROTULO_INDISPONIVEL = "rotulo_indisponivel";

// Palavras que, no rótulo do dispositivo, indicam fone sem fio. "BT" só como
// palavra inteira. É heurística: rótulo sem nenhuma delas não prova que a
// entrada é o microfone do aparelho.
const PADRAO_BLUETOOTH = /bluetooth|airpods|hands[- ]?free|\bBT\b/i;

export const AVISO_RUIDO_ALTO = "ruido_alto";
export const AVISO_ENTRADA_BLUETOOTH = "entrada_bluetooth";

// dBFS relativo à amostra de módulo 1 (uma senoide de pico 1 dá RMS de -3,0
// dBFS). Arredondado a 0,1 dB. Sinal todo zero não tem dB: devolve null.
function emDbfs(valor) {
  return valor > 0 ? Math.round(200 * Math.log10(valor)) / 10 : null;
}

export function medirRuidoDeFundo(amostras) {
  const n = amostras ? amostras.length : 0;
  let soma = 0, pico = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(amostras[i]);
    soma += v * v;
    if (v > pico) pico = v;
  }
  const rms = n ? Math.sqrt(soma / n) : 0;
  return {
    n_amostras: n,
    ruido_rms_dbfs: emDbfs(rms),
    ruido_pico_dbfs: emDbfs(pico),
    // zero amostras ou todas zero: microfone mudo ou sem sinal; registrado,
    // não interpretado
    sinal_nulo: n === 0 || pico === 0,
  };
}

// true/false quando há limiar e medida; null quando falta um dos dois.
export function ruidoAcimaDoLimiar(ruidoRmsDbfs, limiarDbfs) {
  if (typeof limiarDbfs !== "number" || typeof ruidoRmsDbfs !== "number") return null;
  return ruidoRmsDbfs > limiarDbfs;
}

export function configuracoesDoMicrofone(aplicado) {
  const lido = aplicado || {};
  const saida = {};
  for (const k of CONFIGURACOES_BOOLEANAS) {
    saida[k] = typeof lido[k] === "boolean" ? lido[k] : null;
  }
  for (const k of CONFIGURACOES_NUMERICAS) {
    saida[k] = typeof lido[k] === "number" && Number.isFinite(lido[k]) ? lido[k] : null;
  }
  return saida;
}

export function classificarEntrada(rotulo) {
  const texto = String(rotulo || "").trim();
  if (!texto) return ENTRADA_ROTULO_INDISPONIVEL;
  return PADRAO_BLUETOOTH.test(texto) ? ENTRADA_BLUETOOTH : ENTRADA_NAO_BLUETOOTH;
}

// Monta a ficha a partir do que foi lido. O rótulo entra só para ser
// classificado; a ficha devolvida não o contém.
export function montarFichaDoAmbiente({ amostras, taxa, duracaoMs, aplicado, rotulo,
                                        limiarDbfs = LIMIAR_DE_RUIDO_DE_FUNDO_DBFS }) {
  const ruido = medirRuidoDeFundo(amostras);
  const acima = ruidoAcimaDoLimiar(ruido.ruido_rms_dbfs, limiarDbfs);
  const entrada = classificarEntrada(rotulo);
  const avisos = [];
  if (acima === true) avisos.push(AVISO_RUIDO_ALTO);
  if (entrada === ENTRADA_BLUETOOTH) avisos.push(AVISO_ENTRADA_BLUETOOTH);
  return {
    silencio_ms: duracaoMs,
    silencio_medido_ms: typeof taxa === "number" && taxa > 0
      ? Math.round(ruido.n_amostras / taxa * 1000) : null,
    ruido_rms_dbfs: ruido.ruido_rms_dbfs,
    ruido_pico_dbfs: ruido.ruido_pico_dbfs,
    sinal_nulo: ruido.sinal_nulo,
    limiar_de_ruido_dbfs: typeof limiarDbfs === "number" ? limiarDbfs : null,
    ruido_acima_do_limiar: acima,
    configuracoes_do_microfone: configuracoesDoMicrofone(aplicado),
    taxa_do_contexto: typeof taxa === "number" ? taxa : null,
    entrada_de_audio: entrada,
    avisos,
    falha: null,
  };
}

// Ficha de quando a medida não pôde ser feita (microfone negado, erro do
// navegador). A sessão segue; a ficha diz por que ficou vazia.
export function fichaDeFalha(erro) {
  const motivo = String((erro && erro.message) || erro || "erro sem mensagem").slice(0, 200);
  return {
    silencio_ms: null, silencio_medido_ms: null,
    ruido_rms_dbfs: null, ruido_pico_dbfs: null, sinal_nulo: null,
    limiar_de_ruido_dbfs: null, ruido_acima_do_limiar: null,
    configuracoes_do_microfone: configuracoesDoMicrofone(null),
    taxa_do_contexto: null,
    entrada_de_audio: ENTRADA_ROTULO_INDISPONIVEL,
    avisos: [],
    falha: "a medida do ambiente não foi feita: " + motivo,
  };
}

// Grava o silêncio de abertura e monta a ficha. `gravar` e `esperar` são
// injetáveis para os testes; no navegador são `gravador` e `setTimeout`.
export async function medirAmbienteDaSessao({ microfone,
                                              duracaoMs = SILENCIO_DE_ABERTURA_MS,
                                              limiarDbfs = LIMIAR_DE_RUIDO_DE_FUNDO_DBFS,
                                              gravar = gravador,
                                              esperar = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const faixa = microfone.fluxo && microfone.fluxo.getAudioTracks
    ? microfone.fluxo.getAudioTracks()[0] : null;
  const aplicado = faixa && typeof faixa.getSettings === "function"
    ? faixa.getSettings() : null;
  const rotulo = faixa ? faixa.label : "";
  const gravando = gravar(microfone.fluxo, microfone.contexto);
  await esperar(duracaoMs);
  const amostras = gravando.parar();
  return montarFichaDoAmbiente({ amostras, taxa: microfone.taxa, duracaoMs, aplicado,
                                 rotulo, limiarDbfs });
}

// Float32 mono para WAV PCM 16 bits. 16 bits reduz o arquivo à metade do
// float32 e fica muito acima da resolução que a envoltória de amplitude usa.
export function escreverWav(amostras, taxa) {
  const bytesPorAmostra = 2;
  const buffer = new ArrayBuffer(44 + amostras.length * bytesPorAmostra);
  const vista = new DataView(buffer);
  const texto = (posicao, s) => {
    for (let i = 0; i < s.length; i++) vista.setUint8(posicao + i, s.charCodeAt(i));
  };
  const blocoDeDados = amostras.length * bytesPorAmostra;

  texto(0, "RIFF");
  vista.setUint32(4, 36 + blocoDeDados, true);   // tamanho do arquivo − 8
  texto(8, "WAVE");
  texto(12, "fmt ");
  vista.setUint32(16, 16, true);                 // tamanho do bloco fmt
  vista.setUint16(20, 1, true);                  // PCM
  vista.setUint16(22, 1, true);                  // mono
  vista.setUint32(24, taxa, true);
  vista.setUint32(28, taxa * bytesPorAmostra, true);   // bytes por segundo
  vista.setUint16(32, bytesPorAmostra, true);          // alinhamento de bloco
  vista.setUint16(34, 8 * bytesPorAmostra, true);      // bits por amostra
  texto(36, "data");
  vista.setUint32(40, blocoDeDados, true);

  let posicao = 44;
  for (let i = 0; i < amostras.length; i++) {
    // Limita a [-1, 1] antes de converter: fora da faixa o inteiro daria a
    // volta e viraria um estalo, que a envoltória leria como fala.
    const v = Math.max(-1, Math.min(1, amostras[i]));
    vista.setInt16(posicao, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    posicao += bytesPorAmostra;
  }
  return buffer;
}

export function paraBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binario = "";
  const passo = 0x8000;   // em pedaços: String.fromCharCode falha com arrays grandes
  for (let i = 0; i < bytes.length; i += passo) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + passo));
  }
  return btoa(binario);
}

// ---------------------------------------------------------------------------
// Envio para a conta institucional.
//
// O áudio vai do navegador da família direto para a conta institucional do
// estudo, sem passar por máquina pessoal. Voz é dado sensível (LGPD, art. 5º,
// II) e o titular é adolescente (art. 14).
//
// O corpo vai como `text/plain`, embora o conteúdo seja JSON. Com
// `Content-Type: application/json` o navegador faz uma requisição prévia
// (OPTIONS) de CORS, e o Apps Script não responde a OPTIONS: o envio falharia
// antes de chegar. `text/plain` é uma requisição simples, sem essa etapa.

export function montarEnvio({ pessoa, rotulo, sessao, repeticao, conjunto, grupo,
                              condicoes, wavBase64, segredo,
                              preRolagemMs, preRolagemMedidaMs,
                              intervaloModeloGravarMs, intervaloModeloGravacaoMs,
                              modeloTocadoVezes,
                              caudaMs, caudaMedidaMs, saturacao, ambienteDaSessao,
                              tentativas, motivosDasRegravacoes }) {
  // O código do participante é conferido também no navegador, para que um nome
  // chegado por link malformado não saia do aparelho. Aceita `P###`
  // (participante) ou `ENG###` (teste de engenharia), com três dígitos, o mesmo
  // formato que o receptor exige.
  if (!/^(?:P\d{3}|ENG\d{3})$/.test(String(pessoa || ""))) {
    throw new Error(
      "O identificador do participante precisa estar pseudonimizado (P###). " +
      "Peça o link novo a quem te enviou.");
  }
  if (!segredo) {
    throw new Error("O link está incompleto. Peça o link novo a quem te enviou.");
  }
  return {
    pessoa, rotulo, sessao, conjunto,
    // A repetição torna o nome do arquivo determinístico no receptor: um
    // reenvio da mesma posição é reconhecido como o mesmo áudio e não conta
    // duas vezes.
    repeticao,
    grupo: grupo || undefined,
    condicoes,
    // Número de tomadas até esta. As tomadas descartadas não são salvas; este
    // campo é o registro de que houve regravação. `1` significa que não houve;
    // ausente significa página sem esse campo.
    tentativas: tentativas === undefined ? undefined : Number(tentativas),
    // Motivo técnico detectado pela página, um por regravação (tamanho =
    // tentativas − 1). Ausente significa página sem esse campo.
    motivos_das_regravacoes: motivosDasRegravacoes === undefined
      ? undefined : Array.from(motivosDasRegravacoes),
    segredo,
    // `undefined` indica gravação feita sem pré-rolagem, portanto sem a
    // garantia de silêncio inicial de duração conhecida.
    pre_rolagem_ms: preRolagemMs,
    pre_rolagem_medida_ms: preRolagemMedidaMs,
    // Fluxo em dois toques (08/10/2026): o intervalo entre o fim da última
    // frase-modelo tocada e o toque em Gravar, o intervalo até a gravação
    // começar de fato (inclui a abertura do microfone) e quantas vezes a
    // família tocou em Ouvir nesta tomada. `undefined` indica tomada sem
    // modelo (bancada com o modelo desligado) ou página antiga, que mandava
    // `folga_apos_modelo_ms` em vez destes.
    intervalo_modelo_gravar_ms: intervaloModeloGravarMs,
    intervalo_modelo_gravacao_ms: intervaloModeloGravacaoMs,
    modelo_tocado_vezes: modeloTocadoVezes,
    // Cauda depois de Parar, nominal e medida. `undefined` indica gravação
    // parada no toque, sem cauda.
    cauda_ms: caudaMs,
    cauda_medida_ms: caudaMedidaMs,
    // Pico e fração das amostras no teto. `undefined` indica página sem a
    // medida ligada.
    saturacao_pico: saturacao ? saturacao.pico : undefined,
    saturacao_fracao_no_teto: saturacao ? saturacao.fracao_no_teto : undefined,
    // Ficha do ambiente da sessão (`montarFichaDoAmbiente`), repetida em cada
    // gravação da sessão. `undefined` indica página sem a medida ligada.
    ambiente_da_sessao: ambienteDaSessao || undefined,
    wav_base64: wavBase64,
  };
}

// Prazo do envio. Sem ele, uma conexão travada deixaria a família diante de
// "Enviando…" indefinidamente. 90 s cobrem Apps Script lento e internet ruim;
// depois disso a página desiste e confere na agenda se a gravação chegou. O
// prazo vale até a resposta ser lida inteira: a conexão pode travar depois de
// chegarem os cabeçalhos, no meio do corpo.
export const PRAZO_DO_ENVIO_MS = 90000;

export async function enviarGravacao(url, envio, prazoMs = PRAZO_DO_ENVIO_MS) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), prazoMs);
  try {
    const resposta = await fetch(url, {
      method: "POST",
      // text/plain, ver a nota sobre CORS acima.
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(envio),
      redirect: "follow",   // o Apps Script responde por redirecionamento para googleusercontent
      signal: controle.signal,
    });
    if (!resposta.ok) {
      // O receptor explica a recusa no corpo da resposta; a página mostra esse
      // motivo em vez de uma mensagem genérica de conexão.
      let motivo = "";
      try {
        const corpo = await resposta.text();
        try { motivo = (JSON.parse(corpo) || {}).erro || corpo; }
        catch (_) { motivo = corpo; }
      } catch (_) { motivo = ""; }
      throw new Error(motivo || ("O servidor recusou o envio (HTTP " + resposta.status + ")."));
    }
    return await resposta.json();
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error("O envio demorou demais e foi interrompido.");
    }
    throw e;
  } finally {
    clearTimeout(relogio);
  }
}

// Prazo da consulta à agenda. A página consulta a agenda ao abrir, depois de
// cada envio confirmado e depois de um envio que falhou por conexão; sem prazo,
// uma consulta travada deixaria a tela em "Enviando…" mesmo depois de o envio
// desistir. A consulta é leve (uma listagem de nomes de arquivo), e 30 s cobrem
// o início lento do Apps Script.
export const PRAZO_DA_AGENDA_MS = 30000;

// Devolve `{ ok, corpo }`; `corpo` é null quando a resposta não é JSON. O prazo
// vale até o corpo ser lido.
export async function consultarAgenda(url, prazoMs = PRAZO_DA_AGENDA_MS) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), prazoMs);
  try {
    const resposta = await fetch(url, { cache: "no-store", signal: controle.signal });
    let corpo = null;
    try { corpo = await resposta.json(); }
    catch (e) { if (e && e.name === "AbortError") throw e; }
    return { ok: resposta.ok, corpo };
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error("A consulta à agenda demorou demais e foi interrompida.");
    }
    throw e;
  } finally {
    clearTimeout(relogio);
  }
}

// ---------------------------------------------------------------------------
// Voz-modelo servida pelo receptor (decisão do pesquisador de 16/11/2026).
//
// A frase-modelo é a voz de uma fonoaudióloga da equipe. Publicada ao lado da
// página, no GitHub Pages, ficaria ao alcance de qualquer pessoa com o endereço.
// Por isso ela vem do receptor, no mesmo GET da agenda, só para um link válido
// (`voz_modelo=1`), e a página confere cada arquivo antes de tocar:
//   · o sha256 dos bytes recebidos tem de ser o que o receptor declarou (o
//     arquivo chegou inteiro);
//   · para participante, tem de ser também o registrado na página
//     (`SHA256_DA_VOZ_MODELO`, copiado de `voz_modelo/MANIFESTO.json`): a família
//     ouve o estímulo registrado, e não outro arquivo que alguém pôs na pasta.
// A bancada `ENG###` dispensa a segunda conferência: no servidor local ela ouve a
// voz sintética provisória.
// Falta de uma frase, base64 inválido ou sha256 diferente recusam a sessão com
// o nome da frase; a página nunca grava sem o modelo tocar.

export class FalhaDaVozModelo extends Error {}

// Prazo da consulta à voz-modelo: doze arquivos de uns 70 kB em base64 numa
// resposta só, mais o início lento do Apps Script.
export const PRAZO_DA_VOZ_MODELO_MS = 60000;

export function base64ParaBytes(texto) {
  let bin;
  try {
    bin = atob(String(texto || ""));
  } catch (_) {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(bytes, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  if (!subtle) throw new FalhaDaVozModelo("o navegador não confere arquivos (sem crypto.subtle)");
  const d = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// `corpo` é a resposta do receptor; `rotulos`, as frases do protocolo;
// `esperados`, o sha256 registrado de cada frase, ou null na bancada.
// Devolve `{ <rotulo>: { bytes, sha256 } }` ou lança FalhaDaVozModelo.
export async function conferirVozModelo(corpo, { rotulos, esperados = null,
                                                hash = sha256Hex } = {}) {
  if (!corpo || corpo.erro) {
    throw new FalhaDaVozModelo((corpo && corpo.erro) || "o receptor não mandou a frase de exemplo");
  }
  const voz = corpo.voz_modelo;
  if (!voz || typeof voz !== "object") {
    throw new FalhaDaVozModelo("o receptor não mandou a frase de exemplo");
  }
  if (!Array.isArray(rotulos) || !rotulos.length) {
    throw new FalhaDaVozModelo("o protocolo não tem frases");
  }
  const saida = {};
  for (const rotulo of rotulos) {
    const item = voz[rotulo];
    const bytes = item && base64ParaBytes(item.wav_base64);
    if (!bytes || !bytes.length) {
      throw new FalhaDaVozModelo(`a frase de exemplo "${rotulo}" não chegou`);
    }
    const calculado = await hash(bytes);
    if (calculado !== String(item.sha256 || "").toLowerCase()) {
      throw new FalhaDaVozModelo(`a frase de exemplo "${rotulo}" chegou incompleta`);
    }
    if (esperados && esperados[rotulo] !== calculado) {
      throw new FalhaDaVozModelo(
        `a frase de exemplo "${rotulo}" não é a registrada para o estudo`);
    }
    saida[rotulo] = { bytes, sha256: calculado };
  }
  return saida;
}

// ---------------------------------------------------------------------------
// Frase-modelo gravada, tocada pela página.
//
// A chave é `MODELO_PRE_GRAVADO`, em index.html, e está ligada. Ligada, a página
// toca uma gravação da frase-modelo antes de cada tomada, em vez de o familiar
// dizer a frase. A voz do adulto
// durante a gravação entraria no Genérico, no treino do Personalizado e no
// índice de variabilidade, e nada no processamento a detecta. Ligar esta opção
// muda o procedimento de coleta.
//
// Nenhuma voz é gravada ou sintetizada aqui: a página só toca um arquivo
// fornecido num endereço configurado. Sem endereço, ou se o arquivo não tocar
// até o fim, a página recusa gravar, como faz com um pictograma que não carrega.
//
// A ordem de cada tomada, em dois toques da família (decisão do pesquisador
// de 08/10/2026, 05h41 a 05h46), verificada pelos testes da página:
//   Ouvir  1. se houver microfone aberto, ele é fechado;
//          2. o modelo toca até o evento `ended` (`tocarModeloDaTomada`); o
//             instante do fim fica guardado e a contagem de toques sobe;
//             tocar de novo é permitido e contado;
//   Gravar 3. só com o modelo tocado pelo menos uma vez nesta tomada;
//          4. o microfone abre e a gravação começa (`iniciarTomada`); o
//             intervalo entre o fim do modelo e o toque, e até a gravação
//             começar de fato, vai no envio.
// Com `echoCancellation: false`, qualquer som do alto-falante com a captura
// ativa entraria no arquivo; por isso o modelo toca com o microfone fechado.
//
// Até 07/10/2026 um toque só fazia tudo, com uma folga automática
// (`folga_apos_modelo_ms`, 500 ms no protocolo e 300 ms na bancada) entre o
// fim do modelo e a abertura do microfone. Com o toque em Gravar separado, a
// folga é a da família, medida; a constante e o campo saíram.

// Ritmo da sessão: o intervalo mínimo entre uma gravação confirmada e a próxima
// frase-modelo. O valor vem de `coleta.ritmo` no config, exportado para o
// `protocolo.json`; enquanto não for número, a trava de participante real
// recusa a sessão. A bancada `ENG###` usa o valor de bancada abaixo, que não
// é proposta de valor clínico.
export const RITMO_DE_BANCADA = { intervalo_ate_proxima_frase_ms: 0 };

// O ritmo que vale para esta pessoa: o do protocolo quando o valor é número;
// senão o de bancada, só para `ENG###`; senão `null` (participante real sem
// ritmo definido não chega a gravar, porque a trava recusa antes).
export function ritmoDaSessao(protocolo, bancada) {
  if (!ritmoSemValorFixado(protocolo).length) {
    const r = protocolo.coleta.ritmo;
    return { intervalo_ate_proxima_frase_ms: r.intervalo_ate_proxima_frase_ms,
             origem: "protocolo" };
  }
  return bancada ? { ...RITMO_DE_BANCADA, origem: "bancada" } : null;
}
// Prazo para o modelo terminar. Se `ended` não chegar, a página recusa a
// tomada com motivo, em vez de ficar parada ou gravar por cima.
export const PRAZO_DO_MODELO_MS = 20000;

export class FalhaDoModelo extends Error {}

// Endereço do modelo de uma frase: `<pasta>/<rotulo>.wav`, um arquivo por
// frase, identificado pelo mesmo rótulo usado em `frases_alvo` e na agenda.
// Sem pasta ou sem rótulo devolve "", e `tocarModelo("")` recusa com motivo.
// Barras finais na pasta são removidas.
export function enderecoDoModelo(pasta, rotulo) {
  if (!pasta || !rotulo) return "";
  return `${String(pasta).replace(/\/+$/, "")}/${encodeURIComponent(String(rotulo))}.wav`;
}

// Toca o modelo e resolve só quando ele termina. `criarAudio` é injetável
// para os testes; no navegador é `new Audio(url)`.
export function tocarModelo(url, { criarAudio = (u) => new Audio(u),
                                   prazoMs = PRAZO_DO_MODELO_MS } = {}) {
  if (!url) {
    return Promise.reject(new FalhaDoModelo("modelo sem endereço configurado"));
  }
  return new Promise((resolver, rejeitar) => {
    const som = criarAudio(url);
    const relogio = setTimeout(
      () => rejeitar(new FalhaDoModelo("o modelo não terminou no prazo")), prazoMs);
    som.addEventListener("ended", () => { clearTimeout(relogio); resolver(); });
    som.addEventListener("error", () => {
      clearTimeout(relogio);
      rejeitar(new FalhaDoModelo("o arquivo do modelo não carregou"));
    });
    // No iOS, `play()` só é aceito dentro do gesto do usuário; por isso esta
    // função é chamada no toque em Ouvir, antes de qualquer `await`, ou recebe
    // em `criarAudio` um elemento já destravado no toque (`destravarModelo`),
    // quando a página espera o intervalo entre frases antes de tocar.
    Promise.resolve(som.play()).catch((e) => {
      clearTimeout(relogio);
      rejeitar(new FalhaDoModelo("o navegador não tocou o modelo: " + (e && e.message)));
    });
  });
}

// Destrava o elemento de áudio do modelo dentro do gesto do usuário. No Safari do
// iOS, `play()` só é aceito se o elemento já tocou dentro de um toque; quando a
// página espera o intervalo entre frases antes de tocar o modelo, o `play()` de
// `tocarModelo` cai fora do gesto e pode ser recusado. Esta função é chamada de
// forma síncrona no manipulador do clique, antes de qualquer `await`: cria o
// elemento, chama `play()` e `pause()` em seguida (nada chega ao alto-falante) e
// devolve um `criarAudio` que entrega a `tocarModelo` o mesmo elemento, já
// destravado e rebobinado. A rejeição do `play()` interrompido por `pause()` é
// esperada e descartada; se o destravamento não tiver valido, o `play()` real
// falha em `tocarModelo`, que recusa a tomada com motivo.
// Sem endereço devolve `undefined`, e `tocarModelo("")` recusa como antes.
export function destravarModelo(url, { criarAudio = (u) => new Audio(u) } = {}) {
  if (!url) return undefined;
  const som = criarAudio(url);
  try {
    Promise.resolve(som.play()).catch(() => { /* interrompido pelo pause: esperado */ });
    if (typeof som.pause === "function") som.pause();
  } catch (_) { /* navegador sem play síncrono: o play real decide */ }
  return () => {
    try { som.currentTime = 0; } catch (_) { /* elemento sem posição ajustável */ }
    return som;
  };
}

// Contador de tentativas guardado no navegador. Em memória, ele volta a 1 quando
// a página é recarregada, e a regravação feita antes do recarregamento deixa de
// constar no envio. Guardado no `localStorage`, com chave por participante,
// sessão, frase e repetição, sobrevive ao recarregamento no mesmo aparelho.
// O valor é só a contagem e os códigos técnicos dos motivos; nenhum áudio.
// Sem `localStorage` (modo privado, armazenamento bloqueado), o contador segue
// em memória como antes, e o motivo vai para o console.
export const PREFIXO_DO_CONTADOR = "afi_tentativas";

export function chaveDoContador({ pessoa, sessao, rotulo, repeticao } = {}) {
  const partes = [pessoa, sessao, rotulo, repeticao];
  if (partes.some((v) => v === undefined || v === null || String(v) === "")) return "";
  return [PREFIXO_DO_CONTADOR, ...partes.map((v) => encodeURIComponent(String(v)))].join("|");
}

// O armazenamento do navegador, conferido com uma escrita de prova. `null` quando
// indisponível.
export function armazemDoNavegador(janela = globalThis) {
  try {
    const armazem = janela.localStorage;
    if (!armazem) return null;
    const prova = PREFIXO_DO_CONTADOR + "|prova";
    armazem.setItem(prova, "1");
    armazem.removeItem(prova);
    return armazem;
  } catch (e) {
    console.error("Contador de tentativas só em memória: " + (e && e.message));
    return null;
  }
}

// Tomada em curso. Quando uma gravação começa, o registro da posição ganha o
// campo `pendente`, com o código do motivo que valeria se esta tomada fosse
// descartada (o da falha técnica que a página viu nela, ou
// "sem_motivo_tecnico_registrado"). Enviar e ter a confirmação apaga o registro;
// "Gravar de novo" o regrava sem `pendente`. Se a página for recarregada ou
// fechada com a tomada ainda pendente, a leitura seguinte da mesma posição conta
// essa tomada como regravação, com o código guardado. Sem isso, fechar e reabrir
// a página descartaria uma tomada sem deixar contagem. O campo não traz nada além
// do código técnico.
export const MOTIVO_SEM_FALHA_VISTA = "sem_motivo_tecnico_registrado";

// Lê o contador da posição. Sem registro, devolve o estado inicial (1 tentativa,
// nenhum motivo). Registro ilegível ou incoerente (tentativas não inteiras, ou
// número de motivos diferente de tentativas − 1) também devolve o estado
// inicial, com o motivo no console. Registro com tomada pendente volta com ela
// já contada e com `tomadaAbandonada: true`, para quem chama regravar o registro
// sem o `pendente` e a mesma tomada não ser contada duas vezes.
export function lerContador(armazem, chave) {
  const inicial = { tentativas: 1, motivos: [] };
  if (!armazem || !chave) return inicial;
  let texto = null;
  try { texto = armazem.getItem(chave); } catch (e) {
    console.error("Contador de tentativas não lido: " + (e && e.message));
    return inicial;
  }
  if (texto === null || texto === undefined) return inicial;
  try {
    const lido = JSON.parse(texto);
    const tentativas = Number(lido && lido.tentativas);
    const motivos = lido && lido.motivos;
    if (Number.isInteger(tentativas) && tentativas >= 1 && Array.isArray(motivos)
        && motivos.length === tentativas - 1 && motivos.every((m) => typeof m === "string")) {
      if (lido.pendente === undefined || lido.pendente === null) {
        return { tentativas, motivos: motivos.slice() };
      }
      // uma tomada começou e não foi confirmada nem descartada pelo botão
      const motivo = (typeof lido.pendente === "string" && lido.pendente)
        ? lido.pendente : MOTIVO_SEM_FALHA_VISTA;
      return { tentativas: tentativas + 1, motivos: [...motivos, motivo],
               tomadaAbandonada: true };
    }
  } catch (_) { /* cai no aviso abaixo */ }
  console.error("Contador de tentativas ilegível em " + chave + "; recomeça em 1.");
  return inicial;
}

// `pendente` (opcional): o código do motivo da tomada em curso; ausente quando
// não há tomada em curso na posição.
export function guardarContador(armazem, chave, { tentativas, motivos, pendente }) {
  if (!armazem || !chave) return false;
  const registro = { tentativas, motivos: Array.from(motivos || []) };
  if (pendente) registro.pendente = String(pendente);
  try {
    armazem.setItem(chave, JSON.stringify(registro));
    return true;
  } catch (e) {
    console.error("Contador de tentativas não guardado: " + (e && e.message));
    return false;
  }
}

export function apagarContador(armazem, chave) {
  if (!armazem || !chave) return;
  try { armazem.removeItem(chave); } catch (e) {
    console.error("Contador de tentativas não apagado: " + (e && e.message));
  }
}

export function fecharMicrofone(microfone) {
  if (!microfone) return;
  for (const faixa of microfone.fluxo.getTracks()) faixa.stop();
  if (microfone.contexto && microfone.contexto.close) microfone.contexto.close();
}

// O toque em Ouvir. Fecha o microfone se estiver aberto (o modelo toca sem
// captura ativa), toca o modelo até o fim e devolve o microfone (sempre null
// depois) e o instante em que o modelo terminou, no relógio de `agora`. Se o
// modelo falhar, nada é aberto nem gravado, e a falha sobe (`FalhaDoModelo`).
// `modeloAnterior` é o registro da tomada em curso ({ fim_em, vezes }), ou
// null na primeira vez; o devolvido tem `vezes` somado.
export async function tocarModeloDaTomada({ microfone, fechar, tocar,
                                           modeloAnterior = null,
                                           agora = () => Date.now() }) {
  if (microfone) { fechar(microfone); microfone = null; }
  await tocar();
  const vezes = ((modeloAnterior && modeloAnterior.vezes) || 0) + 1;
  return { microfone, modelo: { fim_em: agora(), vezes } };
}

// O toque em Gravar. Com o modelo desligado (bancada), abre o microfone se
// necessário e começa a gravar. Com o modelo ligado, exige que o modelo tenha
// tocado nesta tomada (`modelo` de `tocarModeloDaTomada`): sem isso recusa com
// `FalhaDoModelo`, e a página nunca grava sem o modelo ter tocado. O microfone
// abre aqui (ele foi fechado antes de o modelo tocar) e a gravação começa.
//
// Devolve também o intervalo: entre o fim do modelo e o toque em Gravar
// (`toque_ms`, o tempo que a família deu ao adolescente), e entre o fim do
// modelo e a gravação começar de fato (`gravacao_ms`, inclui a abertura do
// microfone), além de quantas vezes o modelo tocou. Os três vão no envio.
export async function iniciarTomada({ modeloLigado, microfone, abrir,
                                      iniciarGravacao, modelo = null,
                                      agora = () => Date.now() }) {
  if (!modeloLigado) {
    if (!microfone) microfone = await abrir();
    return { microfone, gravando: iniciarGravacao(microfone), intervalo: null };
  }
  if (!modelo || typeof modelo.fim_em !== "number" || !(modelo.vezes >= 1)) {
    throw new FalhaDoModelo("a frase-modelo ainda não tocou nesta tomada");
  }
  const toque = agora();
  if (!microfone) microfone = await abrir();
  const intervalo = { toque_ms: Math.round(toque - modelo.fim_em),
                      gravacao_ms: Math.round(agora() - modelo.fim_em),
                      vezes: modelo.vezes };
  return { microfone, gravando: iniciarGravacao(microfone), intervalo };
}

// Depois de Parar: com o modelo ligado, o microfone fecha, para que o modelo
// da próxima tomada toque sem captura ativa. Desligado, nada muda.
export function encerrarTomada({ modeloLigado, microfone, fechar }) {
  if (!modeloLigado) return microfone;
  fechar(microfone);
  return null;
}
