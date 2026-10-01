/**
 * How sure the mark is: `current` for a verification that holds, `inactive` for one that
 * does not, and `pending` for one nobody has confirmed yet, which claims nothing and is
 * drawn in the surrounding text colour.
 */
export type MarkTone = 'current' | 'inactive' | 'pending';

const tones: Record<MarkTone, [string, string]> = {
  current: ['#D3444C', '#149766'],
  inactive: ['#149766', '#D3444C'],
  pending: ['currentColor', 'currentColor'],
};

/**
 * The check draws itself in from its left end once the verification holds: when a pill's
 * mark first becomes `current`, and each time the dialog opens on a current one.
 */
export const markStyles = `
  @media (prefers-reduced-motion: no-preference) {
    .mark.current path:last-child { animation: verity-draw .8s cubic-bezier(.65, 0, .35, 1) .1s backwards; }
  }
  @keyframes verity-draw { from { stroke-dasharray: 0 176; } to { stroke-dasharray: 108 176; } }
`;

/** Repaints a mark in place, so answering a check never replaces the drawing. */
export function paintMark(svg: SVGSVGElement, tone: MarkTone): void {
  const colors = tones[tone];

  svg.setAttribute('class', `mark ${tone}`);

  for (const [layer, path] of [...svg.children].entries())
    path.setAttribute('stroke', colors[layer] ?? colors[0]);
}

/** V2: the green check fills its section of the symmetric red V. */
export function verificationMark(tone: MarkTone = 'current'): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '-4 -4 264 264');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const layer of [0, 1]) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', 'M40 36 128 220 216 36');
    path.setAttribute('stroke-width', '32');
    path.setAttribute('stroke-linejoin', 'miter');

    if (layer === 1) {
      path.setAttribute('pathLength', '176');
      path.setAttribute('stroke-dasharray', '108 176');
      path.setAttribute('stroke-dashoffset', '-54');
    }

    svg.append(path);
  }

  paintMark(svg, tone);

  return svg;
}

/**
 * A small drawing inside a status circle. Drawn, not typed: a character sits where its
 * font's metrics put it, which is never quite the middle of the circle around it, and
 * differently so on each platform. A drawing is centred by its own geometry, in the
 * surrounding colour. Each one is drawn about the middle of the same sixteen-unit box.
 */
function statusMark(name: string, shapes: [string, Record<string, string>][]): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `glyph ${name}`);
  svg.setAttribute('focusable', 'false');

  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(namespace, tag);

    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);

    svg.append(shape);
  }

  return svg;
}

/** The clock on an expired record: a face, and hands at three o'clock. */
export const clockMark = () =>
  statusMark('clock', [
    ['circle', { cx: '8', cy: '8', r: '6.2' }],
    ['path', { d: 'M8 4.6V8h2.6' }],
  ]);

/** The dash on a record that is revoked or cannot be shown. */
export const dashMark = () => statusMark('dash', [['path', { d: 'M4.4 8h7.2' }]]);
