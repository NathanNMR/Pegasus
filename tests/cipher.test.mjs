import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePegasus, decodePegasus, letterCalculation, nearbyPrimes, getPegasusAlphabet } from '../public/cipher.js';

test('cifra e decifra todo o alfabeto, maiúsculas e minúsculas', () => {
  const s = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  assert.equal(decodePegasus(encodePegasus(s)), s);
  assert.equal(new Set(getPegasusAlphabet().map(x => x.code)).size, 26);
});
test('preserva exatamente números, todos emojis, acentos e sinais reservados', () => {
  const phrase = 'Olá, João! Amanhã 08:39 — 🤩❤️🏳️‍🌈🪽🐎👨🏽‍💻 🔥\nPreço: R$ 12,50 ⟦X⟧';
  assert.equal(decodePegasus(encodePegasus(phrase)), phrase);
});
test('mapeia todos os números solicitados', () => {
  const result = encodePegasus('1234567890');
  assert.match(result, /⟦N:#\$@⟧/);
  assert.match(result, /⟦N:\(\;>⟧/);
  assert.match(result, /⟦N:ui\[&⟧/);
  assert.match(result, /⟦N:!\+;⟧/);
  assert.match(result, /⟦N:,’wn⟧/);
  assert.match(result, /⟦N:\/>!;#>⟧/);
  assert.match(result, /⟦N:veu\[#;#&⟧/);
  assert.ok(result.includes('⟦N:♤¥₩`⟧'));
  assert.ok(result.includes('⟦N:$&|#⟧'));
  assert.ok(result.includes('⟦N:&>*;^&⟧'));
  assert.equal(decodePegasus(result), '1234567890');
});
test('convenções matemáticas reprodutíveis', () => {
  assert.deepEqual(nearbyPrimes(51), [53, 47]);
  assert.equal(letterCalculation('a').result, -2);
  assert.equal(letterCalculation('e').result, -2);
  assert.equal(letterCalculation('u').result, 3);
  assert.equal(letterCalculation('b').type, 'C');
});
test('rejeita dados inválidos e alteração de token', () => {
  assert.throws(() => decodePegasus('outra coisa'));
  assert.throws(() => decodePegasus('PG1|⟦V:999:0:U:-⟧'));
  assert.throws(() => decodePegasus('PG1|ABC'));
  assert.throws(() => decodePegasus('PG1|⟦'));
});
