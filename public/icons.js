// Sistema de ícones do Pegasus: usa o sprite /icons.svg (Lucide, licença ISC).
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Cria um <svg class="icon"> que referencia um símbolo do sprite. */
export function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}

/** Retorna um elemento com ícone + texto (ex.: itens de menu, etiquetas). */
export function iconLabel(tag, className, iconName, label, iconClass = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.append(icon(iconName, iconClass));
  if (label != null && label !== '') {
    const span = document.createElement('span');
    span.textContent = label;
    element.append(span);
  }
  return element;
}

// As reações são gravadas no banco como caracteres Unicode (compatível com dados antigos),
// mas a interface mostra apenas ícones. As chaves usam escapes para manter o código sem emojis.
export const REACTIONS = new Map([
  ['\u{1F44D}', { icon: 'like', label: 'Curtir', tone: 'like' }],
  ['\u2764\uFE0F', { icon: 'love', label: 'Amei', tone: 'love' }],
  ['\u{1F602}', { icon: 'laugh', label: 'Haha', tone: 'laugh' }],
  ['\u{1F62E}', { icon: 'surprised', label: 'Uau', tone: 'wow' }],
  ['\u{1F622}', { icon: 'sad', label: 'Triste', tone: 'sad' }],
  ['\u{1F525}', { icon: 'fire', label: 'Fogo', tone: 'fire' }],
  ['\u{1F44F}', { icon: 'celebrate', label: 'Parabéns', tone: 'celebrate' }],
  ['\u{1F64F}', { icon: 'thanks', label: 'Obrigado', tone: 'thanks' }],
]);

export function reactionInfo(key) {
  return REACTIONS.get(key) || REACTIONS.get(String(key).replace(/\uFE0F/g, '')) || { icon: 'smile', label: 'Reação', tone: 'like' };
}
