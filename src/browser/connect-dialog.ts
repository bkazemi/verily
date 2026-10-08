import type { ExternalAccount, Inline, Instruction } from '../core/index.js';
import { externalId, externalIdGroups, externalLink, externalName } from '../core/index.js';
import {
  accountCard,
  backMark,
  closeMark,
  linkMark,
  node,
  outward,
  stampLink,
  styles,
} from './evidence-dialog.js';
import { providerMark } from './provider-mark.js';
import { version } from '../version.js';
import type { Result } from './index.js';

/** The holder's own side, as the backend names it. Never carries the private id. */
interface Subject {
  heading: string;
  value: string;
  profileUrl?: string;
}

export interface Methods {
  siteName: string;
  verifierName: string;
  local: Subject;
  methods: { provider: string; method: string; name: string; action: string }[];
}

/** One connect flow as the backend reports it, at whichever step it has reached. */
export interface FlowView {
  id: string;
  phase: 'pending' | 'exchanging' | 'approval' | 'complete' | 'cancelled' | 'failed';
  provider: { id: string; name: string; method: string };
  authorizationUrl?: string;
  instructions?: Instruction[];
  artifact?: 'location' | 'document';
  field?: string;
  /** How a `location` is asked for. Absent, from an older backend, means an address. */
  input?: 'url' | 'text';
  /** What to offer in the field, where a record of the holder's already says. */
  suggested?: string;
  /** Said where what was last handed back was refused and the flow still waits for it. */
  refused?: string;
  note?: string;
  /**
   * A mailed code: what to ask the holder for, and once a code has gone, where it went,
   * whether the last one entered was wrong, and how many tries are left.
   */
  code?: {
    field: string;
    input: 'email' | 'tel';
    sentTo?: string;
    wrong?: boolean;
    triesLeft?: number;
  };
  local?: Subject;
  external?: ExternalAccount;
  joined?: { visibility: 'public' | 'unlisted' };
  /** Said where the method used found another proof standing, which confirming records too. */
  standingNote?: string;
  /** What the holder may choose. Absent, from an older backend, means either. */
  visibilities?: ('public' | 'unlisted')[];
  /** Said beside the public choice, where the backend signs its public records. */
  signedNote?: string;
  reason?: string;
  connectionId?: string;
}

export interface ConnectApi {
  methods(): Promise<Methods>;
  /** Starts a flow by one method: a new link, or a renewal of the record `renew` names. */
  start(provider: string, method: string, renew?: string): Promise<FlowView>;
  read(id: string): Promise<FlowView>;
  submit(id: string, artifact: string): Promise<FlowView>;
  approve(id: string, visibility: 'public' | 'unlisted', cancel: boolean): Promise<Result>;
  /**
   * Sends the sign-in window on its way, where going straight to the provider would not
   * do. Absent, the window is pointed at the flow's `authorizationUrl`.
   */
  enter?(popup: Window, flow: FlowView): void;
}

const connectStyles = `
  ${styles}
  .steps > p:first-child { margin-top: 0; }
  .choices { display: grid; gap: 8px; margin-top: 16px; }
  /* With a way back beside it, the heading sits by that and not in the middle. */
  header.backed h2 { margin-right: auto; }
  .choices .action { display: flex; align-items: center; gap: 8px; }
  .choices .more { margin-left: auto; color: #6b786f; font-weight: 500; font-size: 12px; }
  .row.start { justify-content: start; }
  /* The block scrolls and its frame does not, so the copy button stays in its corner. */
  .code { position: relative; margin: 10px 0; }
  pre { margin: 0; padding: 10px 64px 10px 12px; border: 1px solid #e0e6df; border-radius: 8px; background: #f6f8f5; font: 12px/1.5 ui-monospace, monospace; white-space: pre; overflow-x: auto; }
  .code .action { position: absolute; top: 6px; right: 6px; padding: 3px 8px; font-size: 11px; }
  label { display: grid; gap: 4px; margin-top: 12px; font-weight: 600; }
  input[type=url], input[type=email], input[type=tel], input[type=text], textarea { width: 100%; padding: 8px 10px; border: 1px solid #cfd8d2; border-radius: 8px; font: 13px/1.4 system-ui, sans-serif; color: inherit; background: #fff; }
  textarea { font-family: ui-monospace, monospace; font-size: 12px; resize: vertical; }
  fieldset { margin: 16px 0 0; padding: 10px 14px; border: 1px solid #e0e6df; border-radius: 10px; }
  legend { padding: 0 4px; color: #6b786f; font-size: 11px; font-weight: 550; }
  fieldset label { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; font-weight: 500; }
  /* A radio has no baseline to speak of, so it is set in the middle of the label's first line. */
  fieldset input { flex-shrink: 0; align-self: flex-start; width: 13px; height: 13px; font: inherit; margin-top: 4px; margin-top: calc((1lh - 13px) / 2); margin-bottom: 0; }
  .error { color: #9b2c33; }
`;

/** Puts a copy control on a block the holder must reproduce exactly, as the flow page does. */
function codeBlock(code: string): HTMLDivElement {
  const block = node('div', '', 'code');
  const scroller = node('pre');
  const text = node('code', code);
  const copy = node('button', 'Copy', 'action');

  copy.type = 'button';
  copy.setAttribute('aria-live', 'polite');

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = 'Copied';
    } catch {
      // No clipboard: select it, one keystroke from copied, rather than claim it worked.
      const range = document.createRange();

      range.selectNodeContents(text);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      copy.textContent = 'Selected';
    }

    setTimeout(() => (copy.textContent = 'Copy'), 2000);
  });

  scroller.append(text);
  block.append(scroller, copy);

  return block;
}

/** A paragraph with links in it. A link that is not http(s) is written as its text alone. */
function paragraph(pieces: Inline[]): HTMLParagraphElement {
  const element = node('p');

  for (const piece of pieces) {
    if (typeof piece === 'string') element.append(document.createTextNode(piece));
    else if (httpUrl(piece.href)) element.append(outward(node('a', piece.text), piece.href));
    else element.append(document.createTextNode(piece.text));
  }

  return element;
}

function httpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function button(label: string, primary = false): HTMLButtonElement {
  const element = node('button', label, primary ? 'action primary' : 'action');

  element.type = 'button';

  return element;
}

const openDialogs = new WeakMap<HTMLElement, HTMLDialogElement>();

/**
 * Walks the holder through connecting an account without leaving the page: pick a method,
 * prove it, approve it. A sign-in method still needs the provider's own page, so that one
 * step runs in a small window, and the dialog picks the flow back up once it returns.
 * Resolves when the dialog closes, with how the last flow ended.
 */
export function openConnectDialog(
  opener: HTMLElement,
  api: ConnectApi,
  /**
   * Given when this dialog was opened from another, which it stands in place of: the
   * header then has a way back, and `back` is called once this dialog has closed by it.
   */
  back?: () => void,
  /** The provider to start on, where the holder already said which account they mean. */
  provider?: string,
  /**
   * The record to renew, where the holder asked to show one of their accounts again: each
   * flow started then extends that record under its id. `method` is the one method that
   * may, for a retired record. Where the holder is not offered it, a new link is the way
   * back, and the dialog connects as it would with no record named.
   */
  renew?: { id: string; method?: string },
): Promise<Result> {
  const existing = openDialogs.get(opener);

  if (existing?.open) {
    existing.focus();

    return Promise.resolve({ outcome: 'cancelled' });
  }

  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();

  sheet.replaceSync(connectStyles);
  root.adoptedStyleSheets = [sheet];
  const dialog = node('dialog');
  const heading = node('h2', 'Verify an account');
  const close = node('button', '', 'icon');
  const header = node('header');
  const stamp = node('footer');
  const content = node('div', 'Loading…', 'steps');

  heading.id = 'verily-connect-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.append(closeMark());
  content.setAttribute('aria-live', 'polite');
  stamp.append(stampLink(), node('span', version));
  header.append(heading, close);
  dialog.append(header, content, stamp);
  root.append(dialog);
  document.body.append(host);
  openDialogs.set(opener, dialog);

  let returning = false;

  if (back) {
    const before = node('button', '', 'icon');

    before.type = 'button';
    before.setAttribute('aria-label', 'Back');
    before.append(backMark());
    header.className = 'backed';
    header.replaceChildren(before, heading, close);

    before.onclick = () => {
      returning = true;
      dialog.close();
    };
  }

  let outcome: Result = { outcome: 'cancelled' };
  let methods: Methods | undefined;
  let group = provider;
  let popup: Window | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  /** An approval sent and not yet answered: the dialog's result waits for it. */
  let approving: Promise<unknown> | undefined;
  /**
   * Which step is on screen. Anything asked for on an earlier step is ignored when it
   * answers, so an abandoned flow can never draw over the one that replaced it.
   */
  let step = 0;

  /** Leaves the current step, and stops watching a sign-in window. */
  const leave = () => {
    step++;
    clearInterval(poll);
    poll = undefined;
  };

  /** Leaves the current step, and shuts a sign-in window if one is still up. */
  const settle = () => {
    leave();
    popup?.close();
    popup = null;
  };

  /** Whether the step that asked for something is still the one on screen. */
  const current = (asked: number) => asked === step && dialog.open;

  const failure = (message: string) => {
    settle();
    const again = button('Try again', true);

    again.onclick = () => void choose();
    content.replaceChildren(node('p', message, 'error'), row(again));
  };

  const row = (...buttons: HTMLButtonElement[]) => {
    const element = node('div', '', 'row');

    element.append(...buttons);

    return element;
  };

  /**
   * Runs one request, holding the button that asked for it until it answers, and hands
   * the answer on only if the holder is still on the step that asked.
   */
  const busy = async <T>(
    control: HTMLButtonElement,
    request: () => Promise<T>,
    then: (value: T) => void,
  ) => {
    const asked = step;

    control.disabled = true;

    try {
      const value = await request();

      if (current(asked)) then(value);
    } catch {
      if (current(asked)) failure('That did not go through. Please try again.');
    } finally {
      control.disabled = false;
    }
  };

  const subjectCard = (subject: Subject) =>
    accountCard(
      [document.createTextNode(subject.heading)],
      subject.value,
      undefined,
      subject.profileUrl,
    );

  /**
   * The methods on offer. A provider shown more than one way is one button for that
   * provider, which opens onto its own methods; the rest stand on their own. `group` is
   * remembered, so backing out of a method returns to the list it was picked from.
   */
  async function choose() {
    settle();
    const asked = step;

    try {
      methods ??= await api.methods();
    } catch {
      if (!current(asked)) return;

      content.replaceChildren(
        node('p', 'Sign in to this site to verify an account, then try again.', 'error'),
      );

      return;
    }

    if (!current(asked)) return;

    // A record's renewal stays on its provider, by the one method named where one is.
    const renewing = methods.methods.filter(
      (m) => m.provider === provider && (renew?.method === undefined || m.method === renew.method),
    );

    if (renew && !renewing.length) renew = undefined;

    const all = renew ? renewing : methods.methods;

    // A provider asked for that this holder is not offered leaves every option open.
    if (group !== undefined && !all.some((m) => m.provider === group)) group = undefined;

    const count = (provider: string) => all.filter((m) => m.provider === provider).length;
    const list = node('div', '', 'choices');
    const drawn = new Set<string>();

    for (const choice of all) {
      if (group !== undefined && choice.provider !== group) continue;

      if (group === undefined && count(choice.provider) > 1) {
        if (drawn.has(choice.provider)) continue;

        drawn.add(choice.provider);
        const open = labelled(choice.provider, choice.name);

        open.append(node('span', `${count(choice.provider)} ways ›`, 'more'));
        open.setAttribute('aria-label', `${choice.name}: ${count(choice.provider)} ways`);

        open.onclick = () => {
          group = choice.provider;
          void choose();
        };

        list.append(open);

        continue;
      }

      const control = labelled(choice.provider, choice.action, choice.method);

      control.onclick = () => {
        // Opened in the click itself, or a browser would block it; pointed at the
        // provider once the flow exists.
        if (choice.method === 'oauth') {
          popup = window.open('about:blank', '_blank', 'popup,width=600,height=750');

          if (!popup) {
            failure('Allow pop-ups for this site to sign in, then try again.');

            return;
          }
        }

        void busy(control, () => api.start(choice.provider, choice.method, renew?.id), show);
      };

      list.append(control);
    }

    const name = all.find((m) => m.provider === group)?.name;

    const parts: Node[] = [
      subjectCard(methods.local),
      node(
        'p',
        name
          ? `Choose how to show you control your ${name} account.`
          : 'Choose how to show you control the other account.',
        'explanation',
      ),
      list,
    ];

    if (group !== undefined && !renew) {
      const back = button('‹ All options');

      back.onclick = () => {
        group = undefined;
        void choose();
      };

      parts.push(Object.assign(row(back), { className: 'row start' }));
    }

    content.replaceChildren(...parts);
    list.querySelector('button')?.focus();
  }

  /** A choice button: the provider's mark where it has one, then what the button does. */
  function labelled(provider: string, text: string, method?: string) {
    const control = button('');
    const logo = providerMark(provider, method);

    if (logo) control.append(logo);

    control.append(node('span', text));

    return control;
  }

  /** Draws whichever step the flow is at. */
  function show(flow: FlowView) {
    if (flow.phase === 'pending' && flow.authorizationUrl) {
      leave();

      return signIn(flow);
    }

    settle();

    if (flow.phase === 'pending' && flow.instructions) return publish(flow);

    if (flow.phase === 'pending' && flow.code) return mailed(flow);

    if (flow.phase === 'approval') return approve(flow);

    if (flow.phase === 'complete') {
      outcome = { outcome: 'complete', connectionId: flow.connectionId };

      return done();
    }

    if (flow.phase === 'cancelled') return void choose();

    failure(flow.reason ? `Verification failed: ${flow.reason}.` : 'Verification failed.');
  }

  /**
   * Sends the sign-in window to the provider and watches the flow until it comes back.
   * The flow itself says when it has, so no message from the window is needed or trusted.
   */
  function signIn(flow: FlowView) {
    if (!popup || popup.closed) return failure('The sign-in window was closed.');

    if (api.enter) api.enter(popup, flow);
    else popup.location.href = flow.authorizationUrl!;

    const cancel = button('Cancel');

    cancel.onclick = () => void choose();

    content.replaceChildren(
      node('p', `Continue in the ${flow.provider.name} window that opened.`),
      row(cancel),
    );

    const asked = step;

    poll = setInterval(async () => {
      const closed = !popup || popup.closed;

      try {
        const now = await api.read(flow.id);

        if (!current(asked)) return;

        if (!['pending', 'exchanging'].includes(now.phase)) show(now);
        else if (closed) void choose();
      } catch {
        if (current(asked) && closed) failure('Verification failed.');
      }
    }, 1000);
  }

  function publish(flow: FlowView) {
    const input =
      flow.artifact === 'document'
        ? node('textarea')
        : Object.assign(node('input'), {
            type: flow.input ?? 'url',
            autocapitalize: 'none',
            spellcheck: false,
          });

    input.name = 'artifact';
    input.required = true;
    input.value = flow.suggested ?? '';

    if (input instanceof HTMLTextAreaElement) input.rows = 10;

    const label = node('label', flow.field ?? 'Your proof');

    label.append(input);
    const check = button('Check my proof', true);
    const back = button('Back');

    back.onclick = () => void choose();

    check.onclick = () => {
      if (!input.value.trim()) {
        input.focus();

        return;
      }

      void busy(check, () => api.submit(flow.id, input.value), show);
    };

    content.replaceChildren(
      ...flow.instructions!.map((part) =>
        typeof part === 'string'
          ? node('p', part)
          : Array.isArray(part)
            ? paragraph(part)
            : codeBlock(part.code),
      ),
      ...(flow.refused ? [node('p', flow.refused, 'error')] : []),
      label,
      row(back, check),
      ...(flow.note ? [node('p', flow.note, 'muted')] : []),
    );
  }

  /**
   * A mailed code, in two steps on the one flow: the holder names an address, then enters
   * the code that arrived there. Both go back the way a proof does.
   */
  function mailed(flow: FlowView) {
    const { field, sentTo, wrong, triesLeft } = flow.code!;
    const sent = sentTo !== undefined;

    const input = Object.assign(node('input'), {
      type: sent ? 'text' : flow.code!.input,
      name: 'artifact',
      required: true,
      autocomplete: sent ? 'one-time-code' : flow.code!.input,
    });

    if (sent) {
      input.autocapitalize = 'characters';
      input.spellcheck = false;
    }

    const label = node('label', sent ? 'Your code' : field);

    label.append(input);

    const check = button(
      sent ? 'Check my code' : `Send the ${flow.provider.name.toLowerCase()}`,
      true,
    );

    const back = button('Back');

    back.onclick = () => void choose();

    const send = () => {
      // No form is submitted here, so the browser's own check of the field is asked for:
      // an address it would refuse in a form is refused the same way, in its own words.
      if (!input.value.trim() || !input.checkValidity()) {
        input.reportValidity();
        input.focus();

        return;
      }

      void busy(check, () => api.submit(flow.id, input.value), show);
    };

    check.onclick = send;

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') send();
    });

    const parts: Node[] = [];

    if (sent)
      parts.push(
        node(
          'p',
          `A message was sent to ${sentTo}. Press the button in it, or enter its code here.`,
        ),
      );

    if (sent && wrong)
      parts.push(
        node(
          'p',
          `That code did not match. ${triesLeft === 1 ? 'One try is' : `${triesLeft} tries are`} left.`,
          'error',
        ),
      );

    content.replaceChildren(
      ...parts,
      label,
      row(back, check),
      ...(!sent && flow.note ? [node('p', flow.note, 'muted')] : []),
    );

    input.focus();

    if (!sent) return;

    // The button in the message is pressed somewhere else, so only the flow can say it
    // was. A code half typed is left alone: nothing is redrawn until the step moves on.
    const asked = step;

    poll = setInterval(async () => {
      try {
        const now = await api.read(flow.id);

        if (current(asked) && !['pending', 'exchanging'].includes(now.phase)) show(now);
      } catch {
        // A read that fails says nothing about the flow, which the next one may.
      }
    }, 2000);
  }

  function approve(flow: FlowView) {
    const logo = providerMark(flow.provider.id, flow.provider.method);

    const external = accountCard(
      logo
        ? [logo, document.createTextNode(flow.provider.name)]
        : [document.createTextNode(flow.provider.name)],
      externalName(flow.external!),
      externalIdGroups(flow.external!) ?? externalId(flow.external!),
      externalLink(flow.external!),
    );

    const parts: Node[] = [subjectCard(flow.local!), linkMark(), external];
    const choice = node('fieldset');

    const visibilityText = {
      unlisted: 'Unlisted: only people you share a link with can view it',
      public:
        'Public: anyone can view both sides of this link' +
        (flow.signedNote ? `. ${flow.signedNote}` : ''),
    };

    // The backend refuses any other, so the dialog neither offers one nor sends one.
    const only = flow.visibilities?.length === 1 ? flow.visibilities[0] : undefined;

    if (flow.joined)
      parts.push(
        node(
          'p',
          `This account is already linked here. Confirming adds this method to that connection, and it stays ${flow.joined.visibility}.`,
        ),
      );
    else if (only)
      // Nothing to choose, so the one visibility there is gets said, not offered.
      parts.push(node('p', visibilityText[only]));
    else {
      choice.append(node('legend', 'Evidence visibility'));

      for (const value of ['unlisted', 'public'] as const) {
        const text = visibilityText[value];
        const option = node('label');
        const radio = Object.assign(node('input'), { type: 'radio', name: 'visibility', value });

        radio.checked = value === 'unlisted';
        option.append(radio, document.createTextNode(text));
        choice.append(option);
      }

      parts.push(choice);
    }

    if (flow.standingNote) parts.push(node('p', flow.standingNote));

    if (methods)
      parts.push(
        node(
          'p',
          `${methods.siteName} receives the result. Verified via ${methods.verifierName}.`,
          'muted',
        ),
      );

    const confirm = button(flow.joined ? 'Add to connection' : 'Confirm connection', true);
    const cancel = button('Cancel');

    /** One decision at a time: a second one sent beside the first could answer for it. */
    let deciding = false;

    const decide = async (control: HTMLButtonElement, cancelled: boolean) => {
      if (deciding) return;

      deciding = true;
      const other = control === confirm ? cancel : confirm;
      const picked = choice.querySelector<HTMLInputElement>('input:checked');
      const visibility = only ?? (picked?.value === 'public' ? 'public' : 'unlisted');

      other.disabled = true;

      // The outcome is taken as soon as the server answers, even if the dialog has closed
      // in the meantime: a connection recorded after the holder looked away is still one.
      const request = api.approve(flow.id, visibility, cancelled).then((result) => {
        if (result.outcome === 'complete') outcome = result;

        return result;
      });

      approving = request;

      try {
        await busy(
          control,
          () => request,
          (result) => (result.outcome === 'complete' ? done() : void choose()),
        );
      } finally {
        deciding = false;
        other.disabled = false;
      }
    };

    confirm.onclick = () => void decide(confirm, false);
    cancel.onclick = () => void decide(cancel, true);
    content.replaceChildren(...parts, row(cancel, confirm));
  }

  /** The result is on the page behind the dialog, so there is nothing left to say here. */
  function done() {
    settle();
    dialog.close();
  }

  close.addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();

    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      dialog.close();
  });

  const closed = new Promise<Result>((resolve) =>
    dialog.addEventListener(
      'close',
      () => {
        settle();
        openDialogs.delete(opener);
        host.remove();
        opener.firstElementChild?.shadowRoot?.querySelector<HTMLElement>('button')?.focus();

        if (returning) back!();

        // Closed with an approval still out: its answer decides the result.
        void Promise.resolve(approving)
          .catch(() => {})
          .then(() => resolve(outcome));
      },
      { once: true },
    ),
  );

  dialog.showModal();
  void choose();

  return closed;
}
