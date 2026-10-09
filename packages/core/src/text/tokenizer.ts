/**
 * BERT WordPiece tokenizer (spec §13.3). Reproduces Hugging Face
 * BertNormalizer + BertPreTokenizer + WordPiece for uncased models.
 * Browser-safe: used by the builder and by the runtime, so query and
 * document vectors always come from the same code.
 */

export interface TokenizerConfig {
  vocab: string[];
  unkToken: string;
  continuingSubwordPrefix: string;
  maxInputCharsPerWord: number;
  lowercase: boolean;
  stripAccents: boolean;
  handleChineseChars: boolean;
  cleanText: boolean;
}

const OTHER = /\p{C}/u; // HF is_control: Rust char::is_other (Cc, Cf, Cs, Co, Cn)
const WHITESPACE = /\p{White_Space}/u;
const PUNCT = /\p{P}/u;
const MARK = /\p{Mn}/gu;

function isChinese(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  );
}

function isBertPunct(ch: string, cp: number): boolean {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true;
  }
  return PUNCT.test(ch);
}

export class WordPieceTokenizer {
  readonly vocab: string[];
  readonly unkId: number;
  private readonly ids: Map<string, number>;
  private readonly cfg: TokenizerConfig;

  constructor(cfg: TokenizerConfig) {
    this.cfg = cfg;
    this.vocab = cfg.vocab;
    this.ids = new Map();
    for (let i = 0; i < cfg.vocab.length; i++) this.ids.set(cfg.vocab[i]!, i);
    const unk = this.ids.get(cfg.unkToken);
    if (unk === undefined) throw new Error(`unk token ${cfg.unkToken} not in vocab`);
    this.unkId = unk;
  }

  normalize(text: string): string {
    let out = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (this.cfg.cleanText) {
        if (cp === 0 || cp === 0xfffd) continue;
        if (ch === '\t' || ch === '\n' || ch === '\r') {
          out += ' ';
          continue;
        }
        if (OTHER.test(ch)) continue;
        if (WHITESPACE.test(ch)) {
          out += ' ';
          continue;
        }
      }
      if (this.cfg.handleChineseChars && isChinese(cp)) {
        out += ` ${ch} `;
        continue;
      }
      out += ch;
    }
    if (this.cfg.stripAccents) out = out.normalize('NFD').replace(MARK, '');
    // Per code point, like HF (Rust char::to_lowercase): no context-dependent final-sigma rule.
    if (this.cfg.lowercase) {
      let low = '';
      for (const ch of out) low += ch.toLowerCase();
      out = low;
    }
    return out;
  }

  /** BertPreTokenizer: split on whitespace, then isolate each punctuation char. */
  preTokenize(normalized: string): string[] {
    const words: string[] = [];
    let cur = '';
    for (const ch of normalized) {
      const cp = ch.codePointAt(0)!;
      if (WHITESPACE.test(ch)) {
        if (cur) words.push(cur);
        cur = '';
      } else if (isBertPunct(ch, cp)) {
        if (cur) words.push(cur);
        words.push(ch);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur) words.push(cur);
    return words;
  }

  private wordPiece(word: string, out: number[]): void {
    const chars = Array.from(word);
    if (chars.length > this.cfg.maxInputCharsPerWord) {
      out.push(this.unkId);
      return;
    }
    const pieces: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found = -1;
      while (start < end) {
        let sub = chars.slice(start, end).join('');
        if (start > 0) sub = this.cfg.continuingSubwordPrefix + sub;
        const id = this.ids.get(sub);
        if (id !== undefined) {
          found = id;
          break;
        }
        end--;
      }
      if (found < 0) {
        out.push(this.unkId);
        return;
      }
      pieces.push(found);
      start = end;
    }
    for (const p of pieces) out.push(p);
  }

  /** Token ids without special tokens (spec §13.4 step 1). */
  encode(text: string): number[] {
    const out: number[] = [];
    for (const w of this.preTokenize(this.normalize(text))) this.wordPiece(w, out);
    return out;
  }

  tokens(text: string): string[] {
    return this.encode(text).map((id) => this.vocab[id]!);
  }
}
