/**
 * MT19937 compatível com o `random` do Python, só o necessário para `shuffle`.
 *
 * A divisão das frases de consistência entre as sessões 3 e 4 é sorteada por
 * participante, de forma determinística, em `src/agenda.py`:
 *
 *     random.Random("{semente_do_sorteio}|{pessoa}").shuffle(ordem)
 *
 * É isso que torna "sorteado" e "pré-registrado" compatíveis: qualquer pessoa
 * com o config e o código reproduz a divisão, sem ninguém ter anotado o resultado.
 * Se a página calculasse a agenda com outro sorteio, ela pediria frases
 * diferentes das que o protocolo registra, e o participante gravaria um
 * protocolo que não é o dele. Por isso a reimplementação é fiel, não aproximada.
 *
 * O que precisa ser igual, e cada peça é uma chance de errar:
 *   1. a semeadura de string do Python  (versão 2: bytes + sha512, big-endian)
 *   2. `init_by_array` do MT19937 original
 *   3. `genrand_uint32`
 *   4. `getrandbits(k)`        = genrand_uint32() >>> (32 - k), para k ≤ 32
 *   5. `_randbelow(n)`         = rejeição por bit_length
 *   6. `shuffle`               = Fisher-Yates de trás para a frente
 *
 * Trocar a ordem do passo 6, ou usar `Math.random`, dá uma permutação
 * plausível e errada, e o erro é silencioso, porque o resultado parece um
 * sorteio. Só o teste de equivalência contra o Python pega.
 * Ver `tests/test_agenda_na_pagina.py`.
 *
 * Caminho reserva, não principal: quando a escolha clínica dos blocos está
 * registrada no config (a fonoaudióloga escolhe), ela tem precedência e este
 * sorteio não roda. Este código serve ao ensaio de engenharia e ao teste, e
 * precisa existir mesmo assim, porque é o ensaio que valida a página.
 */

/** SHA-512 mínimo, porque a semeadura de string do Python passa por ele.
 *  Opera em BigInt de 64 bits, que é o tamanho da palavra do SHA-512. */
const K512 = [
  "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc",
  "3956c25bf348b538", "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118",
  "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2",
  "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694",
  "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65",
  "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5",
  "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4",
  "c6e00bf33da88fc2", "d5a79147930aa725", "06ca6351e003826f", "142929670a0e6e70",
  "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df",
  "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b",
  "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30",
  "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8",
  "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8",
  "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373", "682e6ff3d6b2b8a3",
  "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec",
  "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b",
  "ca273eceea26619c", "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178",
  "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b",
  "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c",
  "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817",
].map((h) => BigInt("0x" + h));

const MASK64 = (1n << 64n) - 1n;
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & MASK64;

function sha512(bytes) {
  let h = [
    "6a09e667f3bcc908", "bb67ae8584caa73b", "3c6ef372fe94f82b", "a54ff53a5f1d36f1",
    "510e527fade682d1", "9b05688c2b3e6c1f", "1f83d9abfb41bd6b", "5be0cd19137e2179",
  ].map((x) => BigInt("0x" + x));

  // preenchimento: 0x80, zeros, e o comprimento em bits em 128 bits big-endian
  const comprimentoBits = BigInt(bytes.length) * 8n;
  const preenchido = [...bytes, 0x80];
  while (preenchido.length % 128 !== 112) preenchido.push(0);
  for (let i = 15; i >= 0; i--) {
    preenchido.push(Number((comprimentoBits >> BigInt(8 * i)) & 0xffn));
  }

  const w = new Array(80);
  for (let bloco = 0; bloco < preenchido.length; bloco += 128) {
    for (let i = 0; i < 16; i++) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(preenchido[bloco + i * 8 + j]);
      w[i] = v;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(w[i - 15], 1n) ^ rotr(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr(w[i - 2], 19n) ^ rotr(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & MASK64 & g);
      const t1 = (hh + S1 + ch + K512[i] + w[i]) & MASK64;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK64;
      hh = g; g = f; f = e; e = (d + t1) & MASK64;
      d = c; c = b; b = a; a = (t1 + t2) & MASK64;
    }
    h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh]
      .map((x) => x & MASK64);
  }
  const saida = [];
  for (const palavra of h) {
    for (let i = 7; i >= 0; i--) saida.push(Number((palavra >> BigInt(8 * i)) & 0xffn));
  }
  return saida;
}

/** MT19937, o gerador do módulo `random` do Python. */
class MT19937 {
  constructor() {
    this.mt = new Uint32Array(624);
    this.indice = 625;
  }

  _init_genrand(s) {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const anterior = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      // multiplicação de 32 bits sem perda: 1812433253 * anterior
      const baixo = (anterior & 0xffff) * 1812433253;
      const alto = (((anterior >>> 16) * 1812433253) & 0xffff) << 16;
      this.mt[i] = (baixo + alto + i) >>> 0;
    }
    this.indice = 624;
  }

  /** init_by_array do MT19937 original — é o que o Python usa para semente inteira. */
  init_by_array(chave) {
    this._init_genrand(19650218);
    let i = 1;
    let j = 0;
    let k = Math.max(624, chave.length);
    for (; k > 0; k--) {
      const anterior = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      const baixo = (anterior & 0xffff) * 1664525;
      const alto = (((anterior >>> 16) * 1664525) & 0xffff) << 16;
      this.mt[i] = (((this.mt[i] ^ (baixo + alto)) >>> 0) + chave[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
      if (j >= chave.length) j = 0;
    }
    for (k = 623; k > 0; k--) {
      const anterior = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      const baixo = (anterior & 0xffff) * 1566083941;
      const alto = (((anterior >>> 16) * 1566083941) & 0xffff) << 16;
      this.mt[i] = (((this.mt[i] ^ (baixo + alto)) >>> 0) - i) >>> 0;
      i++;
      if (i >= 624) { this.mt[0] = this.mt[623]; i = 1; }
    }
    this.mt[0] = 0x80000000;
    this.indice = 624;
  }

  genrand_uint32() {
    if (this.indice >= 624) {
      const UPPER = 0x80000000;
      const LOWER = 0x7fffffff;
      for (let i = 0; i < 624; i++) {
        const y = ((this.mt[i] & UPPER) | (this.mt[(i + 1) % 624] & LOWER)) >>> 0;
        let proximo = (this.mt[(i + 397) % 624] ^ (y >>> 1)) >>> 0;
        if (y & 1) proximo = (proximo ^ 0x9908b0df) >>> 0;
        this.mt[i] = proximo;
      }
      this.indice = 0;
    }
    let y = this.mt[this.indice++];
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y >>> 0;
  }

  /** getrandbits do Python, restrito a k ≤ 32 — que é tudo que `shuffle` pede. */
  getrandbits(k) {
    if (k <= 0) return 0;
    if (k > 32) throw new Error("getrandbits acima de 32 bits não é usado por shuffle.");
    return this.genrand_uint32() >>> (32 - k);
  }
}

/** A semeadura de string do Python (version=2):
 *  int.from_bytes(bytes + sha512(bytes).digest(), 'big') */
function _sementeDeTexto(texto) {
  const bytes = Array.from(new TextEncoder().encode(texto));
  const combinado = bytes.concat(sha512(bytes));
  let n = 0n;
  for (const b of combinado) n = (n << 8n) | BigInt(b);
  return n;
}

/** O inteiro vira palavras de 32 bits, little-endian — como o CPython faz. */
function _palavrasDe32(n) {
  if (n === 0n) return [0];
  const palavras = [];
  while (n > 0n) {
    palavras.push(Number(n & 0xffffffffn) >>> 0);
    n >>= 32n;
  }
  return palavras;
}

export class RandomPython {
  constructor(semente) {
    this.gerador = new MT19937();
    const n = typeof semente === "string" ? _sementeDeTexto(semente) : BigInt(semente);
    this.gerador.init_by_array(_palavrasDe32(n < 0n ? -n : n));
  }

  /** `_randbelow_with_getrandbits`: rejeição até cair abaixo de n.
   *
   * O Python usa `k = n.bit_length()`, não `(n-1).bit_length()`. O comentário
   * no CPython diz por quê: *"don't use (n-1) here because n can be 1"*.
   * Para n=8 a diferença é 4 bits contra 3: o fluxo de bits sai alinhado
   * diferente e a permutação inteira muda. O gerador continua idêntico; só o
   * consumo muda, por isso os uint32 brutos podem bater com o Python e as
   * permutações saírem todas erradas. */
  _randbelow(n) {
    if (!n) return 0;
    const bits = n.toString(2).length;          // bit_length(n)
    let r = this.gerador.getrandbits(bits);
    while (r >= n) r = this.gerador.getrandbits(bits);
    return r;
  }

  /** `random.shuffle`: Fisher-Yates de trás para a frente. A ordem importa. */
  shuffle(lista) {
    for (let i = lista.length - 1; i > 0; i--) {
      const j = this._randbelow(i + 1);
      const t = lista[i];
      lista[i] = lista[j];
      lista[j] = t;
    }
    return lista;
  }
}

export const _interno = { sha512, MT19937, _sementeDeTexto, _palavrasDe32 };
