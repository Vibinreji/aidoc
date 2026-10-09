"""Generate tokenizer and embedding parity fixtures from the reference implementations.

Usage: .cache/venv/bin/python -I scripts/gen-parity-fixtures.py <model_dir> <document.md> <out_dir>
Requires: tokenizers, model2vec (reference only; never shipped).
"""
import json
import random
import re
import sys

from model2vec import StaticModel
from tokenizers import Tokenizer

model_dir, doc_path, out_dir = sys.argv[1:4]
random.seed(42)

doc = open(doc_path, encoding="utf-8").read()
doc = re.sub(r"<svg.*?</svg>", " ", doc, flags=re.S)
sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", doc) if len(s.strip()) > 3]
random.shuffle(sentences)

edge = [
    "", " ", "\t\n\r", "Hello, World!", "Café naïve résumé façade", "ÀÉÎÕÜ àéîõü",
    "Self-attention's Q/K/V!", "KV-cache 中文 字符 emoji🙂👍🏽", "unaffable transformerization",
    "x" * 99, "y" * 100, "z" * 101, "a" + "b" * 150 + " end",
    "e.g. i.e. U.S.A. Mr. Smith's", "price: $1,234.56 (approx.) — 50% off; 3×4=12",
    "C++ and C# and F# and .NET", "https://example.com/path?q=1&r=2#frag", "user@example.com",
    "snake_case camelCase PascalCase kebab-case", "softmax(Q·Kᵀ / √d_k) · V", "d_model = 768; W_Q, W_K, W_V",
    "Straße groß ß", "İstanbul ıi IİI", "ΣΊΣΥΦΟΣ σίσυφος", "Ελληνικά", "русский язык",
    "العربية لغة", "हिन्दी भाषा", "ภาษาไทย", "한국어 텍스트", "日本語のテキスト", "ｆｕｌｌｗｉｄｔｈ　ｔｅｘｔ",
    "zero​width‌joiner‍", "soft­hyphen", "nbsp space", "line sep para",
    "control\u0001\u0002\u0007chars", "replacement � char", "nul\u0000byte", "BOM﻿here",
    "tab\tseparated\tvalues", "«guillemets» „quotes“ ‘single’", "ellipsis… dash – em — ",
    "1st 2nd 3rd 4th 2022 2026-10-08 12:30", "GPT-2 Llama-2-7B RoPE ALiBi SwiGLU RMSNorm GQA MQA MoE",
    "[CLS] [SEP] [UNK] [MASK] [PAD]", "##ing ##s ##ed", "a  b   c    d", "ﬁ ligature ﬀ ﬃ", "Ⅻ Ⅳ ①②③",
    "x²+y³=z⁴", "½ ¼ ¾", "™ © ®", "°C °F", "µs μs", "Å Ω K", "ǅ ǈ ǋ", "\U0001d400\U0001d401 math bold",
    "ক্ষ", "ﷺ", "🇺🇸🇯🇵", "👨‍👩‍👧", "áé", "ö", "　ideographic space",
    "ALL CAPS SENTENCE HERE", "MiXeD CaSe", "trailing spaces   ", "   leading spaces",
    "What is self-attention?", "Explain Q, K and V", "What is the relationship between embeddings and attention?",
    "Summarize this section", "What is the KV cache for?", "Who won the 2022 World Cup?",
]

synthetic = []
alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?'\"()-_/éüñçøåœ中文🙂"
for _ in range(80):
    n = random.randint(1, 60)
    synthetic.append("".join(random.choice(alphabet) for _ in range(n)))
words = re.findall(r"\w+", doc)
for _ in range(60):
    synthetic.append(" ".join(random.choice(words) for _ in range(random.randint(1, 12))))

strings = edge + synthetic + sentences
strings = strings[:500] if len(strings) >= 500 else strings
tok = Tokenizer.from_file(f"{model_dir}/tokenizer.json")
cases = [{"text": s, "ids": tok.encode(s, add_special_tokens=False).ids} for s in strings]
json.dump({"model": model_dir.rstrip("/").split("/")[-1], "count": len(cases), "cases": cases},
          open(f"{out_dir}/tokenizer-parity.json", "w", encoding="utf-8"), ensure_ascii=False)

model = StaticModel.from_pretrained(model_dir)
emb_texts = [s for s in strings if s.strip()][:80]
vecs = model.encode(emb_texts)
json.dump({"cases": [{"text": t, "vector": [round(float(x), 7) for x in v]} for t, v in zip(emb_texts, vecs)]},
          open(f"{out_dir}/embedding-parity.json", "w", encoding="utf-8"), ensure_ascii=False)
print(f"tokenizer cases: {len(cases)}, embedding cases: {len(emb_texts)}")
