/**
 * The provider marks, as data, so the badge script and the server's pages draw the same
 * ones. Filled marks are in the text colour; the ones drawn here are rounded strokes.
 */
export interface Mark {
  viewBox: string;
  paths: string[];
  /** Drawn as strokes rather than filled. */
  stroke?: boolean;
}

/** GitHub mark from Primer Octicons (MIT); license in docs/licenses/octicons.txt. */
const github: Mark = {
  viewBox: '0 0 16 16',
  paths: [
    'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656',
  ],
};

/**
 * Discord mark from Simple Icons (CC0); notice in docs/licenses/simple-icons.txt. The mark
 * itself is Discord's trademark, used here only to say an account is a Discord account.
 */
const discord: Mark = {
  viewBox: '0 0 24 24',
  paths: [
    'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z',
  ],
};

/** YouTube mark from Simple Icons (CC0); notice in docs/licenses/simple-icons.txt. */
const youtube: Mark = {
  viewBox: '0 0 24 24',
  paths: [
    'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  ],
};

/**
 * A key, drawn here rather than taken from anywhere. It is not the OpenPGP logo: that mark
 * is somebody's to license and this repository does not ship artwork it cannot account for.
 * A key is also the truer picture, since what was proved is control of one, not membership
 * of an organisation.
 */
const key: Mark = {
  viewBox: '0 0 16 16',
  stroke: true,
  paths: [
    'M7.4 8.6a3.3 3.3 0 1 0-4.7 4.7 3.3 3.3 0 0 0 4.7-4.7Z',
    'M7.4 8.6 14 2',
    'M11.2 4.8l1.6 1.6',
    'M9.4 6.6l1.6 1.6',
  ],
};

/** A globe, drawn here like the key, for a page or a domain on the open web. */
const globe: Mark = {
  viewBox: '0 0 16 16',
  stroke: true,
  paths: [
    'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z',
    'M1.5 8h13',
    'M8 1.5C6.1 3.3 5.1 5.5 5.1 8s1 4.7 2.9 6.5',
    'M8 1.5c1.9 1.8 2.9 4 2.9 6.5s-1 4.7-2.9 6.5',
  ],
};

/** An envelope, drawn here like the key, for a mailbox that read a code sent to it. */
const envelope: Mark = {
  viewBox: '0 0 16 16',
  stroke: true,
  paths: ['M2 3.5h12v9H2z', 'M2.4 4l5.6 4.6L13.6 4'],
};

const marks: Record<string, Mark> = { github, discord, youtube, openpgp: key, email: envelope };

/**
 * The mark for a provider, or nothing where there is none. Returning nothing rather than
 * the provider's name keeps this to one job: a caller that also writes the name would
 * otherwise print it twice, and only the caller knows where the name belongs.
 */
export function markOf(provider: string, method?: string): Mark | undefined {
  // A site names its own link-back providers, so those fall back on the method's mark,
  // which a domain shown by its DNS or by a file shares.
  return (
    marks[provider] ?? (['backlink', 'dns', 'wellknown'].includes(method ?? '') ? globe : undefined)
  );
}

/** The attributes every path of a mark gets, as name and value pairs. */
export const pathAttributes = (mark: Mark): [string, string][] =>
  mark.stroke
    ? [
        ['stroke', 'currentColor'],
        ['stroke-width', '1.6'],
        ['stroke-linecap', 'round'],
        ['stroke-linejoin', 'round'],
      ]
    : [];

/**
 * How sure the verification mark is: `current` for a verification that holds, `inactive`
 * for one that does not, and `pending` for one that claims nothing, such as a retired
 * account, which is drawn in the surrounding text colour.
 */
export type MarkTone = 'current' | 'inactive' | 'pending';

/** The V's two strokes in each tone: the V, then the check drawn inside it. */
export const tones: Record<MarkTone, [string, string]> = {
  current: ['#D3444C', '#149766'],
  inactive: ['#149766', '#D3444C'],
  pending: ['currentColor', 'currentColor'],
};

/** The tone a record's mark is drawn in. A retired account claims nothing, not a failure. */
export function toneOf(evidence: { status: string; expiresAt: number }, now: number): MarkTone {
  if (evidence.status === 'verified' && evidence.expiresAt > now) return 'current';

  return evidence.status === 'retired' ? 'pending' : 'inactive';
}

/** V2: the green check fills its section of the symmetric red V. */
export const verification = {
  viewBox: '-4 -4 264 264',
  /** The box around the strokes alone: the arms' squared ends and the mitred foot. */
  strokes: '25.6 29.1 204.8 228',
  path: 'M40 36 128 220 216 36',
  /** The check's stretch of the V, as a dash along a path measured as 176 long. */
  check: { pathLength: '176', 'stroke-dasharray': '108 176', 'stroke-dashoffset': '-54' },
};
