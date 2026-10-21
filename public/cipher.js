/**
 * Algoritmo Pegasus PG1.
 * Uma transformação matemática reversível (NÃO criptografia segura).
 * Compartilhado entre navegador e servidor.
 *
 * Convenções para resolver ambiguidades da proposta original:
 *  - primo mais próximo do resultado intermediário, empatando pelo menor;
 *  - segundo primo mais próximo pela mesma ordem;
 *  - arredondamento das vogais pela paridade da posição da letra no alfabeto;
 *  - 14 primeiros algarismos de pi: 3.1415926535897;
 *  - sufixo de desambiguação para resultados matemáticos iguais.
 */
export const PEGASUS_VERSION = 'PG1|';
const PI14 = 3.1415926535897;
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const DIGITS = Object.freeze({
  '1': '#$@',
  '2': '(;>',
  '3': 'ui[&',
  '4': '!+;',
  '5': ',’wn',
  '6': '/>!;#>',
  '7': 'veu[#;#&',
  '8': '♤¥₩`',
  '9': '$&|#',
  '0': '&>*;^&',
});
const DECODE_DIGITS = new Map(Object.entries(DIGITS).map(([a, b]) => [b, a]));

function isPrime(num) {
  if (num < 2) return false;
  for (let divisor = 2; divisor * divisor <= num; divisor++) {
    if (num % divisor === 0) return false;
  }
  return true;
}

export function nearbyPrimes(value) {
  const primes = [];
  for (let step = 0; primes.length < 2 && step < 150; step++) {
    const lo = value - step;
    const hi = value + step;
    if (lo >= 2 && isPrime(lo) && !primes.includes(lo)) primes.push(lo);
    if (hi !== lo && isPrime(hi) && !primes.includes(hi)) primes.push(hi);
  }
  return primes.sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b);
}

export function letterCalculation(letter) {
  const normalized = letter.toLowerCase();
  if (!/^[a-z]$/.test(normalized)) throw new Error('Não é letra de A a Z.');
  const position = normalized.charCodeAt(0) - 96;
  if (VOWELS.has(normalized)) {
    const sum = position + 42;
    const prime = nearbyPrimes(sum)[0];
    const quotient = sum / prime;
    const rounded = Number.isInteger(quotient)
      ? quotient
      : position % 2 === 1 ? Math.ceil(quotient) : Math.floor(quotient);
    return { type: 'V', position, intermediate: sum, prime, result: rounded * 5 - 7 };
  }
  const intermediate = position * 13;
  const primes = nearbyPrimes(intermediate);
  const divided = intermediate % 2 === 1;
  const primary = divided ? intermediate / primes[0] : intermediate * primes[1];
  return {
    type: 'C', position, intermediate, prime: divided ? primes[0] : primes[1],
    result: Number(((primary * PI14) / 2 - 2).toFixed(8)),
  };
}

const CHAR_TO_CODE = new Map();
const CODE_TO_CHAR = new Map();
const seen = new Map();
for (const char of 'abcdefghijklmnopqrstuvwxyz') {
  const { type, result } = letterCalculation(char);
  const base = `${type}:${result}`;
  const disambiguator = seen.get(base) || 0;
  seen.set(base, disambiguator + 1);
  const code = `${base}:${disambiguator}`;
  CHAR_TO_CODE.set(char, code);
  CODE_TO_CHAR.set(code, char);
}

export function encodePegasus(input) {
  if (typeof input !== 'string') throw new TypeError('Texto inválido.');
  let encoded = PEGASUS_VERSION;
  for (const unit of input) {
    // Letra com diacrítico, preservando acento e a maiúscula/minúscula.
    const nfd = unit.normalize('NFD');
    const [base, ...marks] = Array.from(nfd);
    if (/^[a-zA-Z]$/.test(base) && marks.every(m => /[\u0300-\u036f]/u.test(m))) {
      const code = CHAR_TO_CODE.get(base.toLowerCase());
      const caseTag = base === base.toUpperCase() ? 'U' : 'L';
      const accents = marks.length ? marks.map(m => m.codePointAt(0).toString(16)).join('.') : '-';
      encoded += `⟦${code}:${caseTag}:${accents}⟧`;
    } else if (DIGITS[unit]) {
      encoded += `⟦N:${DIGITS[unit]}⟧`;
    } else if (unit === '⟦' || unit === '⟧') {
      encoded += `⟦X:${unit.codePointAt(0).toString(16)}⟧`;
    } else {
      // Pontuação, espaços, símbolos fora do alfabeto e emojis ficam literais.
      encoded += unit;
    }
  }
  return encoded;
}

export function decodePegasus(encoded) {
  if (typeof encoded !== 'string' || !encoded.startsWith(PEGASUS_VERSION)) {
    throw new Error('Mensagem não usa o formato Pegasus PG1.');
  }
  const payload = encoded.slice(PEGASUS_VERSION.length);
  let output = '';
  for (let i = 0; i < payload.length;) {
    if (payload.startsWith('⟦', i)) {
      const close = payload.indexOf('⟧', i + 1);
      if (close < 0) throw new Error('Token Pegasus incompleto.');
      const token = payload.slice(i + 1, close);
      if (token.startsWith('N:')) {
        const digit = DECODE_DIGITS.get(token.slice(2));
        if (digit === undefined) throw new Error('Número Pegasus desconhecido.');
        output += digit;
      } else if (token.startsWith('X:')) {
        const value = token.slice(2);
        if (value !== '27e6' && value !== '27e7') throw new Error('Escape inválido.');
        output += String.fromCodePoint(parseInt(value, 16));
      } else {
        const parts = token.split(':');
        if (parts.length !== 5) throw new Error('Letra Pegasus inválida.');
        const [type, result, ordinal, caseTag, accents] = parts;
        const plain = CODE_TO_CHAR.get(`${type}:${result}:${ordinal}`);
        if (!plain || !['U', 'L'].includes(caseTag)) throw new Error('Letra Pegasus desconhecida.');
        const combining = accents === '-' ? '' : accents.split('.').map(hex => {
          if (!/^[0-9a-f]{3,4}$/.test(hex)) throw new Error('Acento inválido.');
          const cp = parseInt(hex, 16);
          if (cp < 0x300 || cp > 0x36f) throw new Error('Acento fora da faixa.');
          return String.fromCodePoint(cp);
        }).join('');
        output += (caseTag === 'U' ? plain.toUpperCase() : plain) + combining;
      }
      i = close + 1;
    } else {
      if (payload.startsWith('⟧', i)) throw new Error('Marcador Pegasus solto.');
      const codepoint = payload.codePointAt(i);
      const literal = String.fromCodePoint(codepoint);
      // Letras e dígitos não devem aparecer diretamente em novas mensagens.
      if (/^[a-zA-Z0-9]$/.test(literal)) throw new Error('Texto não transformado no token Pegasus.');
      output += literal;
      i += literal.length;
    }
  }
  return output.normalize('NFC');
}

export function getPegasusAlphabet() {
  return Array.from(CHAR_TO_CODE.entries()).map(([letter, code]) => ({ letter, code }));
}
