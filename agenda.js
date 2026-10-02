/**
 * A agenda de gravação calculada na própria página, espelho de `src/agenda.py`.
 *
 * Com o receptor no Apps Script não há servidor Python: o Apps Script recebe
 * áudio e não roda o protocolo. A ordem é calculada aqui, a partir do protocolo e
 * do código do participante, e o resultado tem de ser exatamente o mesmo que o
 * Python produz.
 *
 * Não é uma agenda equivalente: é a mesma, posição por posição. Se divergir, o
 * participante grava um protocolo que não é o dele, e a divergência é silenciosa:
 * ninguém percebe olhando a tela.
 * Travado por `tests/test_agenda_na_pagina.py`, que compara as duas
 * implementações para ENG001 a ENG020 em todas as sessões.
 *
 * O que este módulo não faz, de propósito:
 *   · não decide o que já foi gravado: isso vem do `doGet` do receptor;
 *   · não valida condições de canal: isso é do receptor, que é quem vê o banco;
 *   · não guarda nada.
 *
 * Precedência clínica, não técnica: quando `coleta.blocos_de_consistencia[pessoa]`
 * está registrado, ele prevalece (a fonoaudióloga escolhe os blocos sem ver os
 * votos do formulário de escolha das frases, apurados por
 * `scripts/apurar_formulario_das_frases.py`). O sorteio abaixo é reserva, para quando a escolha ainda não existe: o
 * ensaio de engenharia e o teste.
 */

import { RandomPython } from "./rng_python.js";

export class ProtocoloInvalido extends Error {}

/**
 * Ordenação por ponto de código, como o `sorted` do Python.
 *
 * O `sort()` padrão do JavaScript compara por unidade de código UTF-16, e as
 * duas ordens divergem para caracteres fora do plano básico. Rótulos de frase
 * hoje são ASCII, então na prática coincidem, mas depender disso seria depender
 * de um acidente dos dados. Aqui a garantia é explícita.
 */
function ordenarComoPython(lista) {
  return [...lista].sort((a, b) => {
    const A = [...String(a)].map((c) => c.codePointAt(0));
    const B = [...String(b)].map((c) => c.codePointAt(0));
    for (let i = 0; i < Math.min(A.length, B.length); i++) {
      if (A[i] !== B[i]) return A[i] - B[i];
    }
    return A.length - B.length;
  });
}

function sessoesDoProtocolo(config) {
  const coleta = config.coleta || {};
  const sessoes = coleta.sessoes;
  if (!sessoes || !sessoes.length) {
    throw new ProtocoloInvalido(
      "O protocolo chegou sem sessões. Sem protocolo não há agenda, e a agenda é " +
      "o que a família recebe. Avise quem enviou o link.");
  }
  const numeros = sessoes.map((s) => Number(s.numero));
  for (let i = 0; i < numeros.length; i++) {
    if (numeros[i] !== i + 1) {
      throw new ProtocoloInvalido(
        "As sessões do protocolo têm de ser 1..N consecutivas; vieram " +
        JSON.stringify(numeros) + ".");
    }
  }
  return sessoes;
}

export function frasesDoProtocolo(config) {
  return ordenarComoPython(Object.keys(config.frases_alvo || {}));
}

export function subconjuntoDeConsistencia(config) {
  const coleta = config.coleta || {};
  const declarado = coleta.subconjunto_consistencia;
  if (!declarado || !declarado.length) return null;
  const frases = new Set(frasesDoProtocolo(config));
  const fora = declarado.filter((r) => !frases.has(r));
  if (fora.length) {
    throw new ProtocoloInvalido(
      "O subconjunto de consistência nomeia frase que não está nas frases-alvo: " +
      JSON.stringify(ordenarComoPython(fora)) + ".");
  }
  const noSubconjunto = new Set(declarado);
  // a ordem é a das frases-alvo, não a da declaração, igual ao Python
  return frasesDoProtocolo(config).filter((r) => noSubconjunto.has(r));
}

/** {numero_da_sessao: [frases]} — a divisão do subconjunto entre as sessões. */
export function blocosDeConsistencia(config, pessoa) {
  const subconjunto = subconjuntoDeConsistencia(config);
  const coleta = config.coleta || {};
  const sessoesC = sessoesDoProtocolo(config)
    .filter((s) => String(s.conjunto) === "consistencia")
    .map((s) => Number(s.numero));
  if (subconjunto === null || !sessoesC.length) return {};

  if (coleta.dividir_consistencia === false) {
    const todas = {};
    for (const s of sessoesC) todas[s] = [...subconjunto];
    return todas;
  }

  // a escolha clínica tem precedência sobre o sorteio
  const registrada = (coleta.blocos_de_consistencia || {})[pessoa];
  if (registrada) {
    const divisao = {};
    for (const k of Object.keys(registrada)) divisao[Number(k)] = [...registrada[k]];
    const faltando = sessoesC.filter((s) => !(s in divisao));
    if (faltando.length) {
      throw new ProtocoloInvalido(
        "A escolha clínica de blocos para " + pessoa + " não cobre a(s) sessão(ões) " +
        JSON.stringify(faltando) + ".");
    }
    const declaradas = Object.values(divisao).flat();
    const a = ordenarComoPython(declaradas).join("|");
    const b = ordenarComoPython(subconjunto).join("|");
    if (a !== b) {
      throw new ProtocoloInvalido(
        "A escolha clínica para " + pessoa + " não bate com o subconjunto de " +
        "consistência declarado no protocolo.");
    }
    return divisao;
  }

  if (subconjunto.length % sessoesC.length !== 0) {
    throw new ProtocoloInvalido(
      "O subconjunto de consistência tem " + subconjunto.length + " frases e há " +
      sessoesC.length + " sessões de consistência: a divisão não é exata.");
  }

  const semente = String(coleta.semente_do_sorteio ?? "afi") + "|" + String(pessoa);
  const ordem = [...subconjunto];
  new RandomPython(semente).shuffle(ordem);
  const porBloco = ordem.length / sessoesC.length;
  const divisao = {};
  sessoesC.forEach((s, i) => {
    divisao[s] = ordem.slice(i * porBloco, (i + 1) * porBloco);
  });
  return divisao;
}

/**
 * Toda posição esperada, na ordem em que a família vai gravar.
 * Posição = {sessao, rotulo, repeticao, conjunto}.
 *
 * A ordem é por sessão e depois por frase: dentro de uma sessão, as repetições
 * de uma frase ficam juntas. É o que o bloco de consistência exige.
 */
export function posicoesDoProtocolo(config, pessoa) {
  const frases = frasesDoProtocolo(config);
  if (!frases.length) {
    throw new ProtocoloInvalido("O protocolo chegou sem frases-alvo.");
  }
  const subconjunto = subconjuntoDeConsistencia(config);
  const divisao = pessoa != null ? blocosDeConsistencia(config, pessoa) : {};
  const posicoes = [];
  for (const sessao of sessoesDoProtocolo(config)) {
    const numero = Number(sessao.numero);
    let desteBloco;
    if (String(sessao.conjunto) === "consistencia" && subconjunto !== null) {
      desteBloco = pessoa != null
        ? (divisao[numero] !== undefined ? divisao[numero] : subconjunto)
        : subconjunto;
    } else {
      desteBloco = frases;
    }
    for (const rotulo of desteBloco) {
      for (let r = 1; r <= Number(sessao.repeticoes); r++) {
        posicoes.push({
          sessao: numero,
          rotulo,
          repeticao: r,
          conjunto: String(sessao.conjunto),
        });
      }
    }
  }
  return posicoes;
}

/** O roteiro de uma sessão: o que gravar, na ordem. */
export function roteiroDaSessao(config, pessoa, sessao) {
  const numero = Number(sessao);
  const descricao = sessoesDoProtocolo(config).find((s) => Number(s.numero) === numero);
  if (!descricao) {
    throw new ProtocoloInvalido(
      "A sessão " + numero + " não está no protocolo.");
  }
  const posicoes = posicoesDoProtocolo(config, pessoa).filter((p) => p.sessao === numero);
  return {
    sessao: numero,
    conjunto: String(descricao.conjunto),
    repeticoes: Number(descricao.repeticoes),
    frases: [...new Set(posicoes.map((p) => p.rotulo))],
    posicoes,
  };
}

/**
 * A próxima posição a gravar, dado o que o receptor disse que já chegou.
 *
 * `jaGravadas` é a lista que o `doGet` devolve: só chaves, nunca nomes de
 * pasta, nunca o segredo. A página não decide o que existe: ela pergunta.
 */
export function proximaPosicao(config, pessoa, jaGravadas) {
  const feitas = new Set(
    (jaGravadas || []).map((g) => [g.sessao, g.rotulo, g.repeticao].join("|")));
  for (const p of posicoesDoProtocolo(config, pessoa)) {
    if (!feitas.has([p.sessao, p.rotulo, p.repeticao].join("|"))) return p;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// O resumo que a página mostra
// ═══════════════════════════════════════════════════════════════════════
//
// A página calcula a agenda sozinha. O receptor (Apps Script, ou o servidor
// local) só diz o que já chegou (`recebidas` e `canais` do `doGet`), e a agenda
// sai daqui, do `protocolo.json`. Mesmo formato do `resumo` de `src/agenda.py`,
// campo a campo, para a página não ter dois caminhos.
// Uma sessão por dia, com recusa e sem exceção. A data de cada gravação é a que o
// receptor guardou (UTC), lida no dia local do aparelho da família.

export const POLITICAS_DE_SESSAO = ["recusa", "avisa", "recusa_com_escape"];

const doisDigitos = (n) => String(n).padStart(2, "0");

/** 'AAAA-MM-DD' do dia local de um instante (Date ou texto ISO). */
export function dataLocal(instante) {
  const d = instante instanceof Date ? instante : new Date(String(instante));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${doisDigitos(d.getMonth() + 1)}-${doisDigitos(d.getDate())}`;
}

/** O dia seguinte a 'AAAA-MM-DD', no calendário (sem fuso). */
export function diaSeguinte(dia) {
  const [a, m, d] = String(dia).split("-").map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + 1));
  return `${x.getUTCFullYear()}-${doisDigitos(x.getUTCMonth() + 1)}-${doisDigitos(x.getUTCDate())}`;
}

/** 'AAAA-MM-DD' → 'DD/MM', para a família. */
export function dataParaAFamilia(dia) {
  const [, m, d] = String(dia).split("-");
  return `${d}/${m}`;
}

/**
 * As posições que faltam, na ordem. Conta por (sessão, frase), como
 * `agenda.pendentes` no Python: a repetição que chegou não importa, o número
 * de arquivos daquela frase naquela sessão sim.
 */
export function pendentesNaPagina(config, pessoa, recebidas) {
  const gravadas = new Map();
  for (const g of recebidas || []) {
    const chave = `${Number(g.sessao)}|${g.rotulo}`;
    gravadas.set(chave, (gravadas.get(chave) || 0) + 1);
  }
  const faltando = [];
  for (const p of posicoesDoProtocolo(config, pessoa)) {
    const chave = `${p.sessao}|${p.rotulo}`;
    if ((gravadas.get(chave) || 0) > 0) {
      gravadas.set(chave, gravadas.get(chave) - 1);
      continue;
    }
    faltando.push(p);
  }
  return faltando;
}

/**
 * true se a política recusa abrir a sessão `sessao` hoje; false se pode;
 * null quando não se sabe (política ausente), o mesmo `None` do Python.
 */
export function outraSessaoHoje(config, recebidas, sessao, hoje) {
  const politica = (config.coleta || {}).sessao_por_dia;
  if (!POLITICAS_DE_SESSAO.includes(politica) || sessao == null || !hoje) return null;
  const outras = new Set();
  for (const g of recebidas || []) {
    // gravação sem data não conta como de hoje: contar seria supor
    if (!g.recebida_em) continue;
    if (dataLocal(g.recebida_em) === hoje && Number(g.sessao) !== Number(sessao)) {
      outras.add(Number(g.sessao));
    }
  }
  if (!outras.size) return false;
  return politica !== "avisa";
}

function comApresentacao(config, posicao) {
  if (!posicao) return null;
  const rotulo = posicao.rotulo;
  const pictogramas = (config.pictogramas || {})[rotulo] || null;
  const texto = (config.frases_alvo || {})[rotulo];
  const coleta = config.coleta || {};
  const palavraSob = Boolean(coleta.palavra_sob_pictograma);
  let palavras = null;
  if (palavraSob) {
    const lista = (config.palavras_dos_pictogramas || {})[rotulo];
    if (Array.isArray(lista) && Array.isArray(pictogramas)
        && lista.length === pictogramas.length
        && lista.every((p) => String(p).trim())) {
      palavras = lista.map((p) => String(p).trim());
    }
  }
  return Object.assign({}, posicao, {
    // sem sequência a página recusa gravar (nunca moldura genérica)
    pictogramas,
    // a frase alimenta só o botão "ver a frase", da família; o adolescente vê só pictogramas
    frase: typeof texto === "string" ? texto : "",
    palavra_sob_pictograma: palavraSob,
    frase_sobre_pictogramas: Boolean(coleta.frase_sobre_pictogramas),
    palavras,
  });
}

/**
 * O resumo da página a partir do protocolo e do que o receptor devolveu.
 * @param {object} config    o `protocolo.json`
 * @param {string} pessoa    o código do link
 * @param {object} retorno   `{recebidas: [...], canais: {...}}` do receptor
 * @param {string} hoje      'AAAA-MM-DD' local do aparelho
 */
export function resumoNaPagina(config, pessoa, retorno, hoje) {
  const recebidas = (retorno && retorno.recebidas) || [];
  const todas = posicoesDoProtocolo(config, pessoa);
  const faltando = pendentesNaPagina(config, pessoa, recebidas);
  const proxima = faltando.length ? faltando[0] : null;
  const recusa = proxima ? outraSessaoHoje(config, recebidas, proxima.sessao, hoje) : null;
  let condicoes = null;
  if (proxima) {
    const canal = ((retorno && retorno.canais) || {})[String(proxima.sessao)];
    const jaComecou = recebidas.some((g) => Number(g.sessao) === proxima.sessao);
    if (jaComecou && canal && canal.dispositivo && canal.ambiente) {
      condicoes = { dispositivo: String(canal.dispositivo), ambiente: String(canal.ambiente),
                    posicao: String(canal.posicao || "") };
    }
  }
  return {
    pessoa,
    total: todas.length,
    faltam: faltando.length,
    concluidas: todas.length - faltando.length,
    concluida: faltando.length === 0,
    proxima: comApresentacao(config, proxima),
    outra_sessao_hoje: recusa,
    // a data mínima que a regra permite: o dia seguinte. Não é intervalo
    // clínico entre sessões, que ainda não está definido e depende da escolha
    // do pesquisador responsável.
    data_sugerida: recusa ? diaSeguinte(hoje) : null,
    condicoes_da_sessao: condicoes,
  };
}

/**
 * O nome determinístico do arquivo. É a chave da não duplicação: o mesmo
 * envio, reenviado, produz o mesmo nome, e o receptor sobrescreve ou recusa em
 * vez de criar um segundo arquivo.
 *
 * Sem data no nome, de propósito. Com data, um reenvio depois da meia-noite
 * criaria um arquivo novo e a gravação contaria duas vezes.
 */
export function nomeDeterministico(pessoa, sessao, rotulo, repeticao) {
  return [
    String(pessoa),
    "s" + String(sessao),
    String(rotulo),
    "r" + String(repeticao).padStart(2, "0"),
  ].join("_");
}
