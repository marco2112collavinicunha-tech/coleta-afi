/**
 * Trava de participante real.
 *
 * O marcador "[A DEFINIR PELAS FONOAUDIÓLOGAS]" da regra do bloco não pode ir para família
 * real antes de ser trocado (em 07/10/2026 o texto da página passou a trazer os valores
 * fixados pelo pesquisador: pausa de 1 min entre blocos e limite de 15 min, e o marcador saiu).
 * Sem trava, um link com `?p=P001` abriria a sessão com pictogramas provisórios e sem o
 * subconjunto de consistência declarado, e a família gravaria. Enquanto houver entrada em
 * `coleta.validacao_pendente`, ela segura a sessão (em 07/10/2026, 18h34, o pesquisador deu
 * pictogramas e subconjunto como validados e as entradas saíram). Em 07/10/2026 à noite o
 * único motivo que restava era o valor do fim da fala cortada (criterios_da_classe_1); em
 * 08/10/2026 ele foi fixado em 0,1 s junto com a cauda depois de Parar, e a trava não tem mais
 * motivo pendente com o protocolo exportado. Esta função devolve a lista de motivos, em PT-BR,
 * pelos quais a sessão de participante real não pode abrir; lista vazia quer dizer que pode.
 *
 * O pseudônimo de bancada `ENG###` nunca é travado: é com ele que a página é ensaiada enquanto
 * o protocolo está provisório. Qualquer outro pseudônimo (`P###`, com ou sem
 * `g=afi`/`g=tipico`) é tratado como participante real.
 *
 * A trava não decide nada clínico: não escolhe pausa, teto, figura nem subconjunto, nem os
 * valores técnicos de exclusão. Ela só recusa enquanto essas coisas continuam marcadas como
 * não definidas.
 * É trava da página: quem abre o arquivo e muda o código passa por ela. O receptor tem as
 * próprias travas (`src/ensaio.py`, `exigir_bancada`).
 */

export const MARCADOR_A_DEFINIR = "[A DEFINIR";
export const PICTOGRAMA_PROVISORIO = "🚧";

/**
 * O que ainda espera validação das fonoaudiólogas, em `coleta.validacao_pendente` no config
 * (exportado para o `protocolo.json`). Desde 06/10/2026 os pictogramas são ARASAAC
 * candidatos e o subconjunto de consistência é proposta: nenhum dos dois tem mais o marcador
 * "🚧" nem está ausente, então a trava precisa de outro sinal para continuar recusando. Cada
 * entrada com texto é um motivo; a entrada some do config quando as fonos confirmam.
 * A trava não decide o que foi validado: só lê o que o config declara pendente.
 */
export const VALIDACAO_PENDENTE = {
  pictogramas: "pictogramas candidatos",
  subconjunto_consistencia: "subconjunto de consistência aprovado pelo pesquisador, à espera da confirmação de uma fonoaudióloga (coleta.subconjunto_consistencia)",
};

export function pendenciasDeValidacao(protocolo) {
  const pendente = ((protocolo && protocolo.coleta) || {}).validacao_pendente;
  if (pendente == null) return [];
  // formato inesperado não é "nada pendente": não saber não é "pode"
  if (typeof pendente !== "object" || Array.isArray(pendente)) return ["(formato ilegível)"];
  return Object.keys(pendente).filter((k) => {
    const v = pendente[k];
    return !(v === null || v === false || (typeof v === "string" && v.trim() === ""));
  });
}

/**
 * Critérios técnicos da falha de gravação que ainda não têm valor fixado. Sem eles, a
 * gravação saturada ou cortada não teria como ser excluída pela regra declarada, e a
 * coleta começaria com uma regra de exclusão incompleta. Os valores vêm de
 * `audio.criterios_da_classe_1` no `config.yaml`, exportados para o `protocolo.json`.
 * Desde 08/10/2026 (decisão do pesquisador, 10h45) a duração máxima não exclui: o valor
 * marca a gravação para a escuta (src/preprocess.py, `duracao_acima_do_limite`); a trava
 * continua exigindo que ele seja número, porque o sinal precisa de um limite.
 * A trava não escolhe valor: só exige que cada um seja número (ou um grupo de números,
 * como início e fim da fala cortada).
 */
export const CRITERIOS_DA_CLASSE_1 = {
  saturacao: "saturação",
  fala_cortada: "fala cortada no início ou no fim",
  duracao_maxima_s: "duração máxima",
};

function valorFixado(v) {
  if (typeof v === "number") return Number.isFinite(v);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const folhas = Object.values(v);
    return folhas.length > 0 && folhas.every(valorFixado);
  }
  return false;
}

export function criteriosDaClasse1SemValor(protocolo) {
  const fixados = (protocolo && protocolo.criterios_da_classe_1) || {};
  return Object.keys(CRITERIOS_DA_CLASSE_1).filter((k) => !valorFixado(fixados[k]));
}

/**
 * Ritmo da sessão sem valor fixado: o intervalo mínimo entre uma gravação confirmada e a
 * próxima frase-modelo, em `coleta.ritmo` no config. O valor é do pesquisador, com validação
 * das fonoaudiólogas por vir; a trava só exige que seja número não negativo.
 * Desde 08/10/2026 a folga depois da frase-modelo não existe mais: a família toca em Ouvir e
 * depois em Gravar, e o intervalo entre os dois é medido, não fixado (captura.js).
 */
export const RITMO = {
  intervalo_ate_proxima_frase_ms: "intervalo até a próxima frase",
};

export function ritmoSemValorFixado(protocolo) {
  const ritmo = ((protocolo && protocolo.coleta) || {}).ritmo || {};
  return Object.keys(RITMO).filter((k) => {
    const v = ritmo[k];
    return !(typeof v === "number" && Number.isFinite(v) && v >= 0);
  });
}

export function ehEngenharia(pessoa) {
  return /^ENG\d{3}$/.test(String(pessoa || ""));
}

/**
 * @param {object} p
 * @param {string} p.pessoa           pseudônimo do link (`?p=`)
 * @param {string} [p.grupo]          grupo do link (`?g=`), só para o texto do motivo
 * @param {string[]} p.textosVisiveis textos que a família pode ver nesta página
 * @param {object|null} p.protocolo   o `protocolo.json` lido, ou null se não carregou
 * @param {boolean} [p.vozModeloDefinitiva] a página tem a voz-modelo definitiva
 * @returns {string[]} motivos da recusa; vazio quando a sessão pode abrir
 */
export function motivosDaTrava({ pessoa, grupo, textosVisiveis, protocolo,
                                 vozModeloDefinitiva = false }) {
  if (ehEngenharia(pessoa)) return [];
  const motivos = [];
  // A página toca a frase-modelo. Participante real só grava quando a voz
  // definitiva estiver na página (desde 07/10/2026 ela está: `voz_modelo/`,
  // gravada por uma fonoaudióloga da equipe; a página passa `vozModeloDefinitiva`
  // a partir de ENDERECO_DOS_MODELOS). Sem a voz, só a sintética provisória dos
  // testes ENG### existe, e o motivo abaixo diz isso. Sem o argumento, o padrão
  // é "pendente": não saber não é "pode".
  const semVozDefinitiva = () => {
    if (!vozModeloDefinitiva) {
      motivos.push("voz-modelo definitiva pendente (a página só tem a voz sintética "
        + "provisória dos testes de engenharia)");
    }
  };
  if ((textosVisiveis || []).some((t) => String(t || "").includes(MARCADOR_A_DEFINIR))) {
    motivos.push("a página ainda mostra texto marcado \"[A DEFINIR PELAS FONOAUDIÓLOGAS]\" "
      + "(pausa entre blocos e tempo máximo da sessão)");
  }
  if (!protocolo || typeof protocolo !== "object") {
    // sem protocolo não se confere nada, e não conferir não é "pode"
    motivos.push("não consegui ler o protocolo (protocolo.json) para conferir os "
      + "pictogramas e o subconjunto de consistência");
    semVozDefinitiva();
    return motivos;
  }
  const pictogramas = protocolo.pictogramas || {};
  const provisorias = Object.keys(pictogramas).filter((rotulo) =>
    (pictogramas[rotulo] || []).some((s) => String(s).includes(PICTOGRAMA_PROVISORIO)));
  if (provisorias.length) {
    motivos.push(`${provisorias.length} frase(s) ainda com pictograma provisório `
      + `(${PICTOGRAMA_PROVISORIO}), à espera das fonoaudiólogas`);
  }
  const subconjunto = (protocolo.coleta || {}).subconjunto_consistencia;
  if (!Array.isArray(subconjunto) || subconjunto.length === 0) {
    motivos.push("o subconjunto de consistência (coleta.subconjunto_consistencia) não "
      + "está declarado");
  }
  const pendencias = pendenciasDeValidacao(protocolo);
  if (pendencias.length) {
    motivos.push("aguardando validação das fonoaudiólogas: "
      + pendencias.map((k) => VALIDACAO_PENDENTE[k] || k).join(", ")
      + " (coleta.validacao_pendente no config)");
  }
  const semValor = criteriosDaClasse1SemValor(protocolo);
  if (semValor.length) {
    motivos.push("critérios técnicos de exclusão sem valor fixado ("
      + semValor.map((k) => CRITERIOS_DA_CLASSE_1[k]).join(", ")
      + "; audio.criterios_da_classe_1 no config)");
  }
  const ritmoSemValor = ritmoSemValorFixado(protocolo);
  if (ritmoSemValor.length) {
    motivos.push("ritmo da sessão sem valor fixado ("
      + ritmoSemValor.map((k) => RITMO[k]).join(", ")
      + "; coleta.ritmo no config)");
  }
  semVozDefinitiva();
  if (motivos.length && (grupo === "afi" || grupo === "tipico")) {
    motivos.unshift(`sessão de participante real (grupo ${grupo}) recusada`);
  }
  return motivos;
}
