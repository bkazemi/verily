import { markOf, pathAttributes } from '../marks.js';

const namespace = 'http://www.w3.org/2000/svg';

/**
 * The mark for a provider as an element, or nothing where there is none. Returning nothing
 * rather than the provider's name keeps this to one job: a caller that also writes the
 * name would otherwise print it twice, and only the caller knows where the name belongs.
 */
export function providerMark(provider: string, method?: string): SVGSVGElement | undefined {
  const mark = markOf(provider, method);

  if (!mark) return undefined;

  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', mark.viewBox);
  svg.setAttribute('class', 'provider');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', mark.stroke ? 'none' : 'currentColor');

  for (const d of mark.paths) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);

    for (const [name, value] of pathAttributes(mark)) path.setAttribute(name, value);

    svg.append(path);
  }

  return svg;
}
