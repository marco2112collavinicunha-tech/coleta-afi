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

// Pré-rolagem: a gravação começa antes de o estímulo aparecer, para que o
// silêncio inicial tenha duração conhecida e nenhum movimento de busca
// articulatória possa começar antes de PRE_ROLAGEM_MS. Com silêncio inicial de
// duração variável, o consenso entre repetições pode situar o início da fala
// dentro do silêncio. A ordem de processamento é: pré-rolagem, corte por
// energia, consenso. A instrução à família não muda.
//
// Cauda: com a chave `CAUDA_APOS_PARAR` da página ligada, a gravação continua
// CAUDA_MS depois do toque em Parar (`pararComCauda`), porque a família tende a
// tocar Parar colado ao fim da fala e o fim da produção pode ficar de fora. A
// cauda só acrescenta áudio; não corta nada. O valor é provisório e a chave
// está desligada até o valor ser escolhido.
export const PRE_ROLAGEM_MS = 1000;
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
                              folgaAposModeloMs, folgaAposModeloMedidaMs,
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
    // Folga entre o fim da frase-modelo e o início da gravação, nominal e
    // medida. `undefined` indica tomada sem modelo tocado.
    folga_apos_modelo_ms: folgaAposModeloMs,
    folga_apos_modelo_medida_ms: folgaAposModeloMedidaMs,
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
// A ordem de cada tomada, verificada pelos testes da página:
//   1. se houver microfone aberto, ele é fechado;
//   2. o modelo toca até o evento `ended`;
//   3. espera-se a folga (`FOLGA_APOS_MODELO_MS`);
//   4. só então o microfone abre e a gravação, com pré-rolagem, começa.
// Com `echoCancellation: false`, qualquer som do alto-falante com a captura
// ativa entraria no arquivo; por isso o modelo toca com o microfone fechado.
//
// A folga é provisória e não foi medida: `ended` indica que o elemento de áudio
// terminou, não que o alto-falante silenciou, e a latência de saída em fone
// Bluetooth passa de 100 ms. 300 ms é margem de bancada, a medir nos aparelhos.
// A pré-rolagem de 1 s vem depois dela.
export const FOLGA_APOS_MODELO_MS = 300;

// Ritmo da sessão: a folga depois da frase-modelo e o intervalo mínimo entre uma
// gravação confirmada e a próxima frase. Os valores são clínicos e vêm de
// `coleta.ritmo` no config, exportado para o `protocolo.json`; enquanto não forem
// números, a trava de participante real recusa a sessão. A bancada `ENG###` usa
// os valores de bancada abaixo, que não são proposta de valor clínico.
export const RITMO_DE_BANCADA = { folga_apos_modelo_ms: FOLGA_APOS_MODELO_MS,
                                  intervalo_ate_proxima_frase_ms: 0 };

// O ritmo que vale para esta pessoa: o do protocolo quando os dois valores são
// números; senão o de bancada, só para `ENG###`; senão `null` (participante real
// sem ritmo definido não chega a gravar, porque a trava recusa antes).
export function ritmoDaSessao(protocolo, bancada) {
  if (!ritmoSemValorFixado(protocolo).length) {
    const r = protocolo.coleta.ritmo;
    return { folga_apos_modelo_ms: r.folga_apos_modelo_ms,
             intervalo_ate_proxima_frase_ms: r.intervalo_ate_proxima_frase_ms,
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
    // função é chamada no toque em Gravar, antes de qualquer `await`, ou recebe
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

const esperarMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Começa uma tomada. Com o modelo desligado, abre o microfone se necessário e
// começa a gravar. Com o modelo ligado, segue a ordem descrita acima.
//
// Com o modelo ligado, devolve também a folga: a nominal e a medida entre o fim
// do modelo e o início da gravação, que inclui a abertura do microfone. É a
// folga efetiva que a criança teve, e vai no envio de cada gravação.
export async function iniciarTomada({ modeloLigado, microfone, abrir, fechar,
                                      tocar, iniciarGravacao,
                                      esperar = esperarMs,
                                      folgaMs = FOLGA_APOS_MODELO_MS,
                                      agora = () => Date.now() }) {
  if (!modeloLigado) {
    if (!microfone) microfone = await abrir();
    return { microfone, gravando: iniciarGravacao(microfone), folga: null };
  }
  // 1. microfone fechado antes de o modelo tocar
  if (microfone) { fechar(microfone); microfone = null; }
  // 2. o modelo toca até o fim; se falhar, nada é aberto nem gravado
  await tocar();
  const fimDoModelo = agora();
  // 3. folga para o alto-falante silenciar
  await esperar(folgaMs);
  // 4. só agora o microfone abre e a gravação começa
  microfone = await abrir();
  const folga = { ms: folgaMs, medida_ms: Math.round(agora() - fimDoModelo) };
  return { microfone, gravando: iniciarGravacao(microfone), folga };
}

// Depois de Parar: com o modelo ligado, o microfone fecha, para que o modelo
// da próxima tomada toque sem captura ativa. Desligado, nada muda.
export function encerrarTomada({ modeloLigado, microfone, fechar }) {
  if (!modeloLigado) return microfone;
  fechar(microfone);
  return null;
}
