/** Sentence splitting. Uses Intl.Segmenter where available, with a regex fallback. Browser-safe. */

const ABBREV = /\b(e\.g|i\.e|etc|vs|cf|fig|al|approx|no|dr|mr|mrs|ms)\.$/i;

export function splitSentences(text: string, language = 'en'): string[] {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  let parts: string[];
  if (Seg) {
    parts = Array.from(new Seg(language, { granularity: 'sentence' }).segment(text), (s) => s.segment);
  } else {
    parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
  }
  // Merge splits after common abbreviations and keep line breaks as hard boundaries.
  const merged: string[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && ABBREV.test(prev.trim())) merged[merged.length - 1] = prev + p;
    else merged.push(p);
  }
  const out: string[] = [];
  for (const m of merged) for (const line of m.split('\n')) if (line.trim()) out.push(line.trim());
  return out;
}
