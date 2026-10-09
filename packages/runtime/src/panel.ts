/** The "Ask this document" panel (spec §15.3–15.6). */
import type { Answer, Citation, Engine, PathStep, SearchHit, Sentence } from './engine.ts';
import type { ConceptNode, QuizItem } from '@aidoc/core/src/node/references.ts';
import { button, h, paragraphs } from './dom.ts';
import { currentSectionId, goTo } from './navigate.ts';

export const NOT_COVERED = "This document doesn't seem to cover that.";

export class Panel {
  private engine: Engine | null = null;
  private readonly root: HTMLElement;
  private readonly launcher: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly empty: HTMLElement;
  private authorLabel = 'Prepared by the author';
  private ready = false;
  private pending: (() => void)[] = [];

  constructor() {
    this.launcher = button([h('span', { 'aria-hidden': 'true' }, '💬 '), 'Ask this document'], () => this.toggle(), {
      class: 'aidoc-launch',
      'aria-expanded': 'false',
      'aria-controls': 'aidoc-panel',
      'aria-keyshortcuts': '/',
    });
    this.status = h('p', { class: 'aidoc-status', role: 'status' }, 'Loading…');
    this.empty = h('div', { class: 'aidoc-empty' });
    this.log = h('div', { class: 'aidoc-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Answers' }, this.empty);
    this.input = h('input', { type: 'text', class: 'aidoc-input', placeholder: 'Ask a question about this document…', 'aria-label': 'Ask a question about this document', maxlength: '1000', autocomplete: 'off', enterkeyhint: 'send' });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.input.value.trim()) {
        e.preventDefault();
        this.submit(this.input.value.trim());
      }
    });
    const quick = h(
      'div',
      { class: 'aidoc-quick', role: 'group', 'aria-label': 'Quick actions for the section in view' },
      button('Summarize', () => this.submit('Summarize this section', 'Summarize')),
      button('Explain simply', () => this.submit('Explain this section simply', 'Explain simply')),
      button('Quiz me', () => this.submit('Quiz me on this section', 'Quiz me')),
      button('Key concepts', () => this.submit('Key concepts in this section', 'Key concepts')),
    );
    this.panel = h(
      'aside',
      { id: 'aidoc-panel', class: 'aidoc-panel', 'aria-label': 'Ask this document', hidden: true },
      h(
        'header',
        { class: 'aidoc-head' },
        h('h2', { class: 'aidoc-title' }, 'Ask this document'),
        h('span', { class: 'aidoc-badge', title: 'Everything runs inside this file. Nothing you type leaves your device.' }, '🔒 Offline · Private'),
        button('×', () => this.close(), { class: 'aidoc-close', 'aria-label': 'Close panel' }),
      ),
      this.log,
      h('div', { class: 'aidoc-foot' }, quick, h('div', { class: 'aidoc-row' }, this.input, button('Ask', () => this.input.value.trim() && this.submit(this.input.value.trim()), { class: 'aidoc-send' })), this.status),
    );
    this.root = h('div', { id: 'aidoc-ui' }, this.panel, this.launcher);
    document.body.append(this.root);
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.open();
      } else if (e.key === 'Escape' && !this.panel.hidden) {
        this.close();
      }
    });
  }

  setEngine(engine: Engine, status: string): void {
    this.engine = engine;
    if (engine.d.manifest.provenance.generatedContent === 'unreviewed') this.authorLabel = 'Prepared by the author (AI-generated, not reviewed)';
    this.setStatus(status);
    if (!this.ready) {
      this.ready = true;
      this.renderEmpty();
      for (const p of this.pending.splice(0)) p();
    }
  }

  setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  fail(message: string): void {
    this.setStatus(message);
    this.input.disabled = true;
  }

  private renderEmpty(): void {
    const e = this.engine!;
    this.empty.replaceChildren(
      h('p', {}, `Ask anything about “${e.d.manifest.title}”. Answers come from this document only, with links to where they were found.`),
      ...(e.suggestions().length
        ? [h('p', { class: 'aidoc-muted' }, 'Try:'), h('div', { class: 'aidoc-suggest' }, ...e.suggestions().map((q) => button(q, () => this.submit(q))))]
        : []),
    );
  }

  open(): void {
    this.panel.hidden = false;
    this.launcher.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('aidoc-open');
    this.input.focus();
  }

  close(): void {
    this.panel.hidden = true;
    this.launcher.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('aidoc-open');
    this.launcher.focus();
  }

  toggle(): void {
    if (this.panel.hidden) this.open();
    else this.close();
  }

  private narrow(): boolean {
    return window.matchMedia?.('(max-width: 899px)').matches ?? false;
  }

  /** Jump to a cited passage; on small screens the bottom sheet is closed first so the passage is visible. */
  private jump(target: { blockId?: string; sectionId?: string }, sentence?: string): void {
    if (this.narrow() && !this.panel.hidden) {
      this.panel.hidden = true;
      this.launcher.setAttribute('aria-expanded', 'false');
      document.documentElement.classList.remove('aidoc-open');
    }
    goTo(target, sentence);
  }

  submit(query: string, display = query, sectionOverride?: string): void {
    this.open();
    this.input.value = '';
    if (!this.engine) {
      this.pending.push(() => this.submit(query, display, sectionOverride));
      return;
    }
    this.empty.remove();
    const msg = h('div', { class: 'aidoc-msg aidoc-user' }, display);
    const t0 = performance.now();
    const { answer } = this.engine.ask(query, { currentSectionId: sectionOverride ?? currentSectionId() });
    const card = this.render(answer);
    card.dataset.ms = String(Math.round(performance.now() - t0));
    card.dataset.kind = answer.kind;
    this.log.append(msg, card);
    msg.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  // ---- rendering ---------------------------------------------------------------

  private label(kind: 'author' | 'document'): HTMLElement {
    return kind === 'author'
      ? h('p', { class: 'aidoc-prov aidoc-prov-author' }, h('span', { 'aria-hidden': 'true' }, '✍️ '), this.authorLabel)
      : h('p', { class: 'aidoc-prov aidoc-prov-doc' }, h('span', { 'aria-hidden': 'true' }, '📄 '), 'Found in the document');
  }

  private chips(cites: Citation[], sentenceFor?: (c: Citation) => string | undefined): HTMLElement | null {
    if (!cites.length) return null;
    return h(
      'div',
      { class: 'aidoc-sources', role: 'group', 'aria-label': 'Sources' },
      ...cites.map((c) => button([h('span', { 'aria-hidden': 'true' }, '📍 '), c.title], () => this.jump(c, sentenceFor?.(c)), { class: 'aidoc-chip', title: `Go to “${c.title}”` })),
    );
  }

  private followUps(sectionId: string | undefined): HTMLElement | null {
    if (!sectionId) return null;
    return h(
      'div',
      { class: 'aidoc-follow', role: 'group', 'aria-label': 'Follow-up actions' },
      button('Explain simply', () => this.submit('Explain this section simply', 'Explain simply', sectionId)),
      button('Related', () => this.submit('Key concepts in this section', 'Related concepts', sectionId)),
      button('Quiz me on this', () => this.submit('Quiz me on this section', 'Quiz me on this', sectionId)),
    );
  }

  private card(...children: (Node | null | false | undefined)[]): HTMLElement {
    return h('div', { class: 'aidoc-msg aidoc-answer' }, ...children);
  }

  private quote(sentences: Sentence[]): HTMLElement {
    return h(
      'blockquote',
      { class: 'aidoc-quote' },
      ...sentences.map((s) => {
        const c = this.engine!.d.chunks[s.chunkIndex]!;
        return h('p', {}, button(s.text, () => this.jump({ blockId: s.blockId, sectionId: c.sectionId }, s.text), { class: 'aidoc-quote-link', title: 'Show in the document' }));
      }),
    );
  }

  private hits(hits: SearchHit[]): HTMLElement {
    return h(
      'ol',
      { class: 'aidoc-hits' },
      ...hits.map((hit) =>
        h(
          'li',
          {},
          button(
            [h('span', { class: 'aidoc-path' }, hit.headingPath.slice(1).join(' › ') || hit.headingPath.join(' › ')), h('span', { class: 'aidoc-snip' }, hit.snippet)],
            () => this.jump({ blockId: hit.blockId, sectionId: hit.sectionId }, hit.snippet.endsWith('…') ? undefined : hit.snippet),
            { class: 'aidoc-hit' },
          ),
        ),
      ),
    );
  }

  private conceptChip(n: ConceptNode): HTMLElement {
    return n.sectionId ? button(n.label, () => this.jump({ sectionId: n.sectionId! }), { class: 'aidoc-concept', title: `Go to “${this.engine!.title(n.sectionId)}”` }) : h('span', { class: 'aidoc-concept' }, n.label);
  }

  private edge(st: PathStep): HTMLElement {
    const [a, b] = st.forward ? [st.from, st.to] : [st.to, st.from];
    return h('li', {}, this.conceptChip(a), h('span', { class: 'aidoc-rel' }, ` ${st.relation} → `), this.conceptChip(b));
  }

  render(a: Answer): HTMLElement {
    const e = this.engine!;
    switch (a.kind) {
      case 'faq':
        return this.card(this.label('author'), ...paragraphs(a.faq.answer), this.chips(a.citations), this.followUps(a.citations[0]?.sectionId));
      case 'extract': {
        const first = new Map<string, string>();
        for (const s of a.sentences) {
          const sec = e.d.chunks[s.chunkIndex]!.sectionId;
          if (!first.has(sec)) first.set(sec, s.text);
        }
        return this.card(
          this.label('document'),
          this.quote(a.sentences),
          this.chips(a.citations, (c) => first.get(c.sectionId)),
          a.more.length ? h('details', { class: 'aidoc-more' }, h('summary', {}, 'More places in the document'), this.hits(a.more)) : null,
          this.followUps(a.citations[0]?.sectionId),
        );
      }
      case 'notCovered':
        return this.card(
          h('p', { class: 'aidoc-notcovered' }, NOT_COVERED),
          a.closest.length ? h('p', { class: 'aidoc-muted' }, 'Closest passages, in case they help:') : null,
          a.closest.length ? this.hits(a.closest) : null,
        );
      case 'search':
        return this.card(this.label('document'), h('p', { class: 'aidoc-muted' }, `Places that discuss this:`), this.hits(a.hits));
      case 'generated': {
        const heading = a.mode === 'summary' ? 'Summary' : a.mode === 'simple' ? 'In simple terms' : 'Key points';
        return this.card(
          h('h3', { class: 'aidoc-card-title' }, `${heading} · ${a.title}`),
          this.label('author'),
          ...(a.text ? paragraphs(a.text) : []),
          a.points ? h('ul', {}, ...a.points.map((p) => h('li', {}, p))) : null,
          this.chips(a.citations),
          this.followUps(a.sectionId),
        );
      }
      case 'docSummary':
        return this.card(
          h('h3', { class: 'aidoc-card-title' }, `Summary · ${e.d.manifest.title}`),
          this.label('author'),
          h('ul', { class: 'aidoc-docsum' }, ...a.items.map((i) => h('li', {}, button(i.title, () => this.jump({ sectionId: i.sectionId }), { class: 'aidoc-linkish' }), ': ', i.text))),
        );
      case 'quiz':
        return this.quiz(a.title, a.items, a.scope);
      case 'relation':
        return this.card(
          h('h3', { class: 'aidoc-card-title' }, `${a.a.label} ↔ ${a.b.label}`),
          a.path.length
            ? h('div', {}, this.label('author'), h('ol', { class: 'aidoc-chain', 'aria-label': 'How the concepts connect' }, ...a.path.map((st) => this.edge(st))))
            : h('p', { class: 'aidoc-muted' }, 'The concept map does not connect these two directly.'),
          a.sentences.length ? h('div', {}, this.label('document'), this.quote(a.sentences)) : null,
          this.chips(a.citations),
        );
      case 'concepts':
        return this.card(
          h('h3', { class: 'aidoc-card-title' }, `Concepts · ${a.title}`),
          this.label('author'),
          a.focus ? null : h('div', { class: 'aidoc-concepts' }, ...a.nodes.map((n) => this.conceptChip(n))),
          a.edges.length ? h('ul', { class: 'aidoc-chain' }, ...a.edges.slice(0, 12).map((st) => this.edge(st))) : null,
          this.chips(a.citations),
        );
      case 'message':
        return this.card(h('p', {}, a.text), this.chips(a.citations));
    }
  }

  private quiz(title: string, items: { sectionId: string; item: QuizItem }[], scope: 'section' | 'document'): HTMLElement {
    const body = h('div', { class: 'aidoc-quiz' });
    const card = this.card(h('h3', { class: 'aidoc-card-title' }, `Quiz · ${title}`), this.label('author'), body);
    let i = 0;
    let score = 0;
    const show = () => {
      if (i >= items.length) {
        body.replaceChildren(
          h('p', { class: 'aidoc-score', role: 'status' }, `You scored ${score} out of ${items.length}.`),
          button('Try again', () => {
            i = 0;
            score = 0;
            show();
          }),
        );
        return;
      }
      const { sectionId, item } = items[i]!;
      const name = `q${Math.random().toString(36).slice(2)}`;
      const feedback = h('div', { class: 'aidoc-feedback', 'aria-live': 'polite' });
      const opts = item.options.map((o, k) => {
        const b = button(o, () => {
          for (const x of opts) x.disabled = true;
          const right = k === item.answerIndex;
          if (right) score++;
          b.classList.add(right ? 'aidoc-right' : 'aidoc-wrong');
          opts[item.answerIndex]!.classList.add('aidoc-right');
          opts[item.answerIndex]!.setAttribute('aria-label', `${item.options[item.answerIndex]} (correct answer)`);
          feedback.replaceChildren(
            h('p', {}, h('strong', {}, right ? 'Correct. ' : 'Not quite. '), item.explanation),
            this.chips([this.engine!.cite(sectionId)]) ?? '',
            button(i + 1 < items.length ? 'Next question' : 'See score', () => {
              i++;
              show();
            }, { class: 'aidoc-next' }),
          );
          (feedback.querySelector('.aidoc-next') as HTMLButtonElement | null)?.focus();
        }, { class: 'aidoc-opt', 'data-name': name });
        return b;
      });
      body.replaceChildren(
        h('p', { class: 'aidoc-muted' }, `Question ${i + 1} of ${items.length}${scope === 'document' ? ` · ${this.engine!.title(sectionId)}` : ''}`),
        h('p', { class: 'aidoc-q' }, item.question),
        h('div', { class: 'aidoc-opts', role: 'group', 'aria-label': 'Answer options' }, ...opts),
        feedback,
      );
    };
    show();
    return card;
  }
}
