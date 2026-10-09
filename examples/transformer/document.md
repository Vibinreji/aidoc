---
title: Understanding Transformer Architecture
language: en
authors: [aidoc example]
license: CC BY 4.0
created: 2026-10-08
---

# Understanding Transformer Architecture

## Overview {#overview}

Almost every modern language model is built on the Transformer, an architecture introduced in 2017 in the paper "Attention Is All You Need" by Vaswani and colleagues. Before Transformers, the leading models for text were recurrent neural networks (RNNs), which read a sentence one word at a time and carried a running memory forward. That design had two problems: it was slow to train, because each step had to wait for the previous one, and it struggled to connect words that were far apart.

The Transformer replaced recurrence with a mechanism called **attention**. Instead of passing information step by step, every position in the input can look directly at every other position and decide how much each one matters. Because these comparisons do not depend on each other, they can all be computed at once on a GPU. This made it practical to train much larger models on much more data, which is the main reason Transformers took over the field.

This document walks through a Transformer from the bottom up, in the order that data actually flows through it:

1. Text is split into **tokens**, small pieces such as words or parts of words.
2. Each token is turned into a vector by an **embedding** table.
3. **Positional encoding** adds information about where each token sits in the sequence.
4. **Attention**, and in particular **self-attention**, lets tokens exchange information.
5. Attention is computed from three projections called **queries, keys and values**.
6. **Multi-head attention** runs several attention operations side by side.
7. A **feed-forward network** processes each token on its own.
8. **Residual connections** and **layer normalization** keep a deep stack of layers stable.
9. These parts are combined into a **Transformer block**, which is repeated many times.
10. At generation time, a **KV cache** avoids recomputing work for tokens the model has already seen.

The original Transformer had two halves: an encoder that read the input and a decoder that produced the output, which suited machine translation. Most of today's chat and text-generation models, such as the GPT family and Llama, use only the decoder half. They are trained to predict the next token given all the tokens before it. This document mostly describes that decoder-only design, and points out where the original encoder-decoder version differs.

<figure>
<svg viewBox="0 0 640 170" width="640" height="170" role="img" aria-labelledby="fig1-title" xmlns="http://www.w3.org/2000/svg">
<title id="fig1-title">Data flow through a decoder-only Transformer: text becomes tokens, tokens become embeddings plus positions, these pass through N Transformer blocks, and a final layer predicts the next token.</title>
<g fill="none" stroke="currentColor" stroke-width="1.5">
<rect x="10" y="60" width="90" height="50" rx="8"/>
<rect x="130" y="60" width="90" height="50" rx="8"/>
<rect x="250" y="60" width="110" height="50" rx="8"/>
<rect x="390" y="45" width="110" height="80" rx="8" stroke-dasharray="5 4"/>
<rect x="530" y="60" width="100" height="50" rx="8"/>
<path d="M100 85 H126 M220 85 H246 M360 85 H386 M500 85 H526"/>
<path d="M121 80 L126 85 L121 90 M241 80 L246 85 L241 90 M381 80 L386 85 L381 90 M521 80 L526 85 L521 90"/>
</g>
<g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
<text x="55" y="82">Text</text><text x="55" y="99" font-size="11">"the cat sat"</text>
<text x="175" y="82">Tokens</text><text x="175" y="99" font-size="11">IDs 1996, 4937…</text>
<text x="305" y="82">Embeddings</text><text x="305" y="99" font-size="11">+ positions</text>
<text x="445" y="80">Transformer</text><text x="445" y="96">block</text><text x="445" y="114" font-size="11">× N layers</text>
<text x="580" y="82">Next-token</text><text x="580" y="99">prediction</text>
</g>
</svg>
<figcaption>Figure 1. The path from text to a next-token prediction in a decoder-only Transformer.</figcaption>
</figure>

## Tokens {#tokens}

A neural network cannot read letters directly. It works with numbers, so the first step is to cut the text into a sequence of **tokens** and give each token an integer ID. The set of all tokens a model knows is its **vocabulary**, and the program that does the cutting is the **tokenizer**.

The simplest choices are not good ones. If every character were a token, the vocabulary would be tiny, but sequences would be very long and each token would carry almost no meaning on its own. If every whole word were a token, sequences would be short, but the vocabulary would need millions of entries, and any word not seen during training, such as a new name, a typo or a rare technical term, would become an "unknown" token and lose its meaning.

Modern models use **subword tokenization**, a compromise between the two. Common words get their own token, while rare words are built from smaller pieces. For example, "transformer" might be a single token, while "transformerization" could be split into "transform", "er" and "ization". Nothing is ever truly unknown, because in the worst case a word can be spelled out from short pieces or even individual bytes.

The three most common subword algorithms are:

- **Byte-Pair Encoding (BPE).** It starts from single characters (or bytes) and repeatedly merges the most frequent adjacent pair into a new token, until the vocabulary reaches a target size. GPT models use byte-level BPE, which guarantees that any text, including emoji and code, can be encoded.
- **WordPiece.** Used by BERT, it is similar to BPE but chooses merges that most increase the likelihood of the training data. Pieces that continue a word are marked with a prefix such as `##`, so "playing" might become "play" and "##ing".
- **Unigram / SentencePiece.** It starts with a large vocabulary and removes the pieces that matter least. SentencePiece treats the input as a raw stream, including spaces, which makes it work well for languages that do not separate words with spaces.

Vocabulary size is a trade-off. GPT-2 used about 50,000 tokens; many recent models use 100,000 to 250,000 so that more words and more languages get compact encodings. A larger vocabulary means shorter sequences, which saves computation in attention, but it also makes the embedding table and the final output layer larger.

Tokenization has visible side effects. A model "sees" tokens, not letters, so tasks like counting the letters in a word or reversing a string can be surprisingly hard for it. The same text can also cost a different number of tokens in different languages, which affects both speed and price. As a rough rule for English, one token is about three quarters of a word, or about four characters.

Tokenizers usually also define a few **special tokens** that never come from normal text, such as a marker for the beginning of a sequence, the end of a sequence, or padding. Chat models add special tokens to separate the system prompt, the user's messages and the assistant's replies.

## Embeddings {#embeddings}

Token IDs are just labels; the number 4937 is not "bigger" or "closer" to 4938 in any meaningful way. The model needs a representation in which similar tokens are close together. That representation is the **embedding**: a vector of real numbers, often with hundreds or thousands of dimensions.

The embedding layer is simply a lookup table, a matrix with one row per token in the vocabulary. If the vocabulary has 50,000 tokens and the model dimension, usually written **d_model**, is 768, the table has 50,000 rows and 768 columns. To embed a token, the model reads the row whose index is the token ID. There is no calculation beyond that lookup.

The values in this table are not designed by hand. They start out random and are learned during training, along with every other parameter. Because the training objective rewards good predictions, tokens that are used in similar contexts end up with similar vectors. Words like "cat" and "dog" drift close together; "Paris" ends up related to "France" in a way that resembles how "Tokyo" relates to "Japan". Distance and direction in this space carry meaning, which is why embeddings are often described as placing words in a **semantic space**.

The dimension d_model is one of the most important numbers in a Transformer. It is the width of the vector that represents each token at every layer, sometimes called the width of the **residual stream**. The original Transformer used 512; GPT-2 small used 768; large modern models use 4,096 to more than 12,000. A wider model can store more information about each token, at the cost of more computation and memory.

An embedding at the input is only a starting point. The vector for "bank" is the same whether the sentence is about rivers or money, because the lookup does not know the context. The job of the layers that follow, above all attention, is to turn these context-free vectors into **contextual representations**, in which "bank" near "river" and "bank" near "loan" end up as different vectors.

At the other end of the model, a similar matrix is used in reverse. The final vector for a position is multiplied by an output matrix with one row per vocabulary token, producing one score, called a **logit**, per token. A softmax turns these scores into probabilities for the next token. Many models **tie** the input and output matrices, using the same weights for both, which saves parameters.

Embeddings are also useful outside of Transformers' internals. Sentence embedding models produce a single vector for a whole sentence or passage, and comparing these vectors with cosine similarity is the basis of semantic search. The "Ask this document" panel in this file uses a small static embedding model of exactly this kind.

## Positional encoding {#positional-encoding}

Attention, as described in the next section, compares every token with every other token. On its own, that comparison has no idea of order: the sentences "the dog bit the man" and "the man bit the dog" contain the same tokens, and without extra information attention would treat them as the same bag of words. Recurrent networks got order for free, because they read tokens one after another. A Transformer has to be told explicitly where each token is. That is the job of **positional encoding**.

The original Transformer used **sinusoidal positional encodings**. For each position in the sequence, it builds a vector the same size as the embedding, where each pair of dimensions holds a sine and a cosine wave of a different frequency:

```
PE(pos, 2i)   = sin(pos / 10000^(2i / d_model))
PE(pos, 2i+1) = cos(pos / 10000^(2i / d_model))
```

Low dimensions oscillate quickly and high dimensions slowly, a bit like the hands of a clock moving at different speeds. Together they give each position a unique pattern. This vector is **added** to the token embedding, so the input to the first layer carries both what the token is and where it is. A useful property of sine waves is that shifting by a fixed offset is a simple linear transformation, which makes it easy for the model to reason about relative distance.

Later models explored other options:

- **Learned absolute positions.** GPT-2 and BERT learned a separate embedding vector for each position, just like token embeddings. This is simple and works well, but the model cannot handle sequences longer than the maximum position it was trained with.
- **Relative position methods.** Instead of labelling absolute positions, these methods tell attention how far apart two tokens are. Distance often matters more than absolute location.
- **Rotary Position Embedding (RoPE).** Used by Llama, Mistral and many recent models, RoPE does not add anything to the embeddings. Instead, it rotates the query and key vectors inside attention by an angle that depends on position. When a query and a key are compared, the result depends only on their relative distance. RoPE is cheap, works well, and can be stretched to longer contexts with techniques such as position interpolation.
- **ALiBi.** It adds a penalty to attention scores that grows with distance, so nearby tokens are favoured. It was designed to let models handle inputs longer than those seen in training.

Whatever the method, the goal is the same: give attention enough information to tell "first" from "last" and "near" from "far".

## Attention and self-attention {#attention}

**Attention** is the core idea of the Transformer. It lets each token gather information from other tokens, with the amount taken from each one decided by the content of the tokens themselves rather than by a fixed rule.

Think about the sentence "The animal didn't cross the street because it was too tired." To understand "it", a reader has to connect it to "animal", not to "street". Attention gives the model a way to do this: when the model processes "it", it can assign a high weight to "animal" and low weights to the other words, and pull in information mostly from "animal".

Formally, attention works in three steps for each token:

1. **Score.** Compare the current token with every token it is allowed to look at, producing one relevance score per token.
2. **Normalize.** Pass the scores through a **softmax**, which turns them into positive weights that add up to 1.
3. **Mix.** Compute a weighted average of information from those tokens, using the weights.

The result is a new vector for the current token that blends in what it found relevant. The exact way scores and information are computed uses queries, keys and values, described in the next section.

**Self-attention** means that the tokens attend to other tokens in the same sequence. In a decoder-only model every attention layer is self-attention. In the original encoder-decoder Transformer there was also **cross-attention**, in which the decoder's tokens attended to the encoder's output, letting the translation being written look at the sentence being translated.

In a language model that generates text left to right, a token must not see the future: when the model is learning to predict the word after "the cat", it would be cheating to look at the next word. This is enforced with a **causal mask**, which sets the scores for all later positions to minus infinity before the softmax, so their weights become zero. This is why such models are also called causal or autoregressive language models. Encoder models like BERT use **bidirectional** attention without this mask, since they read a whole sentence at once rather than generating it.

Attention has two properties that explain both its power and its cost. First, any token can reach any other token in a single step, no matter how far apart they are. An RNN had to carry information through every intermediate step, and it often faded along the way. Second, comparing every token with every other token takes work proportional to the **square** of the sequence length. Doubling the context from 4,000 to 8,000 tokens makes the attention scores four times as expensive. Much research, such as FlashAttention, sliding-window attention and sparse attention, aims to reduce this cost or make it run faster on hardware.

Attention weights are sometimes visualised as heat maps showing which words attend to which. These pictures can be illuminating, but they should be read with care: a model has many layers and many heads, and a single attention map rarely tells the whole story of why the model produced an output.

## Queries, keys and values {#qkv}

Attention needs a way to decide how relevant one token is to another, and a way to decide what information to pass along. The Transformer does this with three different vectors per token, called the **query**, the **key** and the **value**, usually shortened to **Q, K and V**.

A helpful analogy is a library search. The **query** is what you are looking for. Each book has a **key**, like a label on its spine, describing what it is about. You compare your query with every key to see which books match. Then you read the **contents** of the matching books, which are their **values**. Crucially, what makes a book match (its key) can be different from what you take away from it (its value).

In a Transformer, each token's current vector x is multiplied by three learned weight matrices to produce its query, key and value:

```
q = x · W_Q        k = x · W_K        v = x · W_V
```

These matrices are learned during training. The model learns what kinds of questions tokens should ask, what kinds of labels they should advertise, and what information they should hand over when they are selected.

For a whole sequence, the queries, keys and values are stacked into matrices Q, K and V, and attention is computed in one formula:

```
Attention(Q, K, V) = softmax( Q · Kᵀ / √d_k ) · V
```

Reading it from the inside out:

1. **Q · Kᵀ** takes the dot product of every query with every key. A dot product is large when two vectors point in a similar direction, so this gives a matrix of relevance scores, one per pair of tokens.
2. **Divide by √d_k**, the square root of the key dimension. Dot products grow with the number of dimensions. Without this scaling, scores would become very large, the softmax would put almost all weight on a single token, and its gradients would become tiny, slowing learning. This is why the method is called **scaled dot-product attention**.
3. **softmax** (after applying the causal mask, if any) turns each row of scores into weights between 0 and 1 that sum to 1.
4. **Multiply by V**: each token's output is the weighted sum of all the value vectors it attends to.

<figure>
<svg viewBox="0 0 640 200" width="640" height="200" role="img" aria-labelledby="fig2-title" xmlns="http://www.w3.org/2000/svg">
<title id="fig2-title">Scaled dot-product attention: the query is compared with each key, the scores are scaled and passed through softmax to get weights, and the weights are used to average the values.</title>
<g fill="none" stroke="currentColor" stroke-width="1.5">
<rect x="10" y="20" width="70" height="36" rx="6"/>
<rect x="10" y="82" width="70" height="36" rx="6"/>
<rect x="10" y="144" width="70" height="36" rx="6"/>
<rect x="120" y="45" width="110" height="50" rx="8"/>
<rect x="270" y="45" width="110" height="50" rx="8"/>
<rect x="420" y="95" width="90" height="50" rx="8"/>
<rect x="550" y="95" width="80" height="50" rx="8"/>
<path d="M80 38 H100 V62 H116 M80 100 H100 V78 H116 M230 70 H266 M380 70 H400 V112 H416 M80 162 H400 V128 H416 M510 120 H546"/>
<path d="M111 57 L116 62 L111 67 M111 73 L116 78 L111 83 M261 65 L266 70 L261 75 M411 107 L416 112 L411 117 M411 123 L416 128 L411 133 M541 115 L546 120 L541 125"/>
</g>
<g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
<text x="45" y="43">Query Q</text><text x="45" y="105">Keys K</text><text x="45" y="167">Values V</text>
<text x="175" y="67">Q · Kᵀ</text><text x="175" y="84" font-size="11">scores</text>
<text x="325" y="67">÷ √d_k, softmax</text><text x="325" y="84" font-size="11">weights sum to 1</text>
<text x="465" y="117">weighted</text><text x="465" y="133">sum of V</text>
<text x="590" y="125">output</text>
</g>
</svg>
<figcaption>Figure 2. Scaled dot-product attention.</figcaption>
</figure>

Why use three separate projections instead of comparing the token vectors directly? Because the roles are different. A pronoun like "it" might need a query that asks "which noun am I referring to?", while a noun needs a key that says "I am a singular noun that could be referred to", and a value that carries what the noun actually means. Separate matrices let the model learn these roles independently. The same token can be very relevant in one sense and irrelevant in another.

In self-attention, Q, K and V all come from the same sequence. In cross-attention, the queries come from one sequence (the decoder) and the keys and values come from another (the encoder's output).

## Multi-head attention {#multi-head-attention}

A single attention operation produces one set of weights per token, so each token can only follow one pattern of relevance at a time. But language has many kinds of relationships at once: a word may need to know its grammatical subject, the previous word, a matching bracket, and the topic of the paragraph. **Multi-head attention** handles this by running several attention operations, called **heads**, in parallel.

Each head has its own query, key and value matrices, and works in a smaller space. If d_model is 768 and there are 12 heads, each head uses queries, keys and values of dimension 64 (768 ÷ 12). Every head computes scaled dot-product attention independently, producing its own 64-dimensional output per token. The outputs of all heads are then **concatenated** back into a 768-dimensional vector and multiplied by one more learned matrix, the **output projection** W_O, which mixes the heads' results together.

Because each head is smaller, multi-head attention costs about the same as a single full-width head, but it lets the model attend to different things at the same time. Researchers studying trained models have found heads that seem to specialise: some follow syntax, some attend to the previous token, some copy patterns that appeared earlier in the context (so-called **induction heads**, important for in-context learning). Many heads, though, do not have a clean human-readable role, and models are robust to removing some of them.

Typical sizes vary widely. The original Transformer used 8 heads with d_model 512; GPT-2 small used 12 heads with d_model 768; large models use 32 to 128 heads.

Two variants are common in modern models because they reduce memory use during generation (see the KV cache section):

- **Multi-query attention (MQA)**: all query heads share a single key head and a single value head.
- **Grouped-query attention (GQA)**: query heads are split into groups, and each group shares one key head and one value head. For example, 32 query heads might share 8 key/value heads. GQA keeps most of the quality of full multi-head attention while making the KV cache several times smaller; Llama 2 70B and Llama 3 use it.

## Feed-forward network {#feed-forward}

Attention moves information **between** tokens. The second main component of each block, the **feed-forward network (FFN)**, also called the **MLP** (multi-layer perceptron), processes each token **on its own**. The same small network is applied to every position independently, with no communication between positions.

In its classic form, the FFN has two linear layers with a non-linear activation function between them:

```
FFN(x) = W_2 · activation(W_1 · x + b_1) + b_2
```

The first layer **expands** the vector to a larger hidden size, usually four times d_model (for example 768 → 3,072), and the second layer **projects** it back down to d_model. The activation function was ReLU in the original Transformer; GPT-2 and BERT used GELU, a smoother version. Many recent models use gated variants such as **SwiGLU**, which multiply two parallel projections together and tend to train slightly better. With SwiGLU the hidden size is often about 8/3 of d_model, to keep the parameter count similar.

Although it looks simple, the FFN holds most of a Transformer's parameters, roughly two thirds of each block in a standard design. Interpretability research suggests that FFN layers act partly like a large **key-value memory**: the first layer detects patterns in the token's vector, and the second layer writes associated information back. This is one place where a model appears to store factual knowledge, such as which city is the capital of which country.

A useful way to summarise a block is: **attention communicates, the feed-forward network computes.** Attention gathers relevant context from other tokens; the FFN then transforms each token's enriched vector, before the next layer repeats the process.

Some large models replace the single FFN with a **mixture of experts (MoE)**: many FFNs ("experts") exist, and a small router picks only one or two of them for each token. This increases the total number of parameters, and so the model's capacity, without increasing the computation per token by the same amount.

## Residual connections and layer normalization {#residuals-layer-norm}

A large Transformer stacks dozens of layers. Very deep networks are hard to train: signals and gradients can shrink or explode as they pass through many layers, and a small change early in the network can have unpredictable effects later. Two techniques keep a deep Transformer stable: **residual connections** and **layer normalization**.

A **residual connection**, also called a skip connection, adds a sub-layer's input to its output:

```
x = x + SubLayer(x)
```

Instead of replacing the token's vector, each attention or feed-forward sub-layer computes a **change** that is added to it. If a sub-layer has nothing useful to contribute, it can output values near zero and the vector passes through unchanged. During training, gradients can flow straight back through the additions, which avoids the vanishing-gradient problem that made deep networks hard to train before residual connections were introduced in ResNet.

This gives a useful mental model called the **residual stream**: a single vector per token that runs from the embedding at the bottom to the output at the top. Every attention and feed-forward sub-layer **reads** from this stream and **writes** an update back into it. Different layers can communicate through it, a bit like a shared notebook passed up the stack.

**Layer normalization** rescales a vector so that its values have a mean of zero and a variance of one, then applies a learned scale and shift. It is computed separately for each token, across that token's d_model values. Keeping values in a consistent range makes training more stable and less sensitive to the learning rate.

Where the normalization goes matters:

- **Post-LN** (the original Transformer) normalizes after adding the residual: `x = LayerNorm(x + SubLayer(x))`. It can work well but often needs a careful learning-rate warm-up.
- **Pre-LN** (GPT-2 and most modern models) normalizes the input of each sub-layer: `x = x + SubLayer(LayerNorm(x))`. The residual stream itself is never normalized inside the block, which makes very deep models much easier to train. A final layer norm is applied once at the very top.

Many recent models, including Llama, use **RMSNorm**, a simpler version that only rescales by the root mean square of the values, without subtracting the mean. It is slightly cheaper and works about as well.

## The Transformer block {#transformer-block}

All the pieces above come together in the **Transformer block**, also called a layer. A decoder-only model is mostly a stack of identical blocks, each with its own weights. In the common pre-LN design, one block does the following for every token's vector x:

```
x = x + MultiHeadAttention(LayerNorm(x))     # tokens exchange information
x = x + FeedForward(LayerNorm(x))            # each token is processed on its own
```

<figure>
<svg viewBox="0 0 640 230" width="640" height="230" role="img" aria-labelledby="fig3-title" xmlns="http://www.w3.org/2000/svg">
<title id="fig3-title">A pre-LN Transformer block. The residual stream runs straight through. A layer norm and multi-head attention branch off and add their result back; then a layer norm and feed-forward network branch off and add their result back.</title>
<g fill="none" stroke="currentColor" stroke-width="1.5">
<path d="M20 190 H620" stroke-width="3"/>
<path d="M613 185 L620 190 L613 195"/>
<path d="M90 190 V150 M90 110 V70 H180 M260 70 H300 V182"/>
<path d="M360 190 V150 M360 110 V70 H450 M530 70 H570 V182"/>
<rect x="45" y="110" width="90" height="40" rx="6"/>
<rect x="180" y="45" width="80" height="50" rx="6"/>
<rect x="315" y="110" width="90" height="40" rx="6"/>
<rect x="450" y="45" width="80" height="50" rx="6"/>
<circle cx="300" cy="190" r="9"/>
<circle cx="570" cy="190" r="9"/>
<path d="M295 190 H305 M300 185 V195 M565 190 H575 M570 185 V195"/>
</g>
<g fill="currentColor" font-family="system-ui, sans-serif" font-size="13" text-anchor="middle">
<text x="90" y="134">LayerNorm</text>
<text x="220" y="66">Multi-head</text><text x="220" y="82">attention</text>
<text x="360" y="134">LayerNorm</text>
<text x="490" y="66">Feed-</text><text x="490" y="82">forward</text>
<text x="60" y="215" font-size="12">residual stream in</text>
<text x="590" y="215" font-size="12">out</text>
</g>
</svg>
<figcaption>Figure 3. One pre-LN Transformer block. Each sub-layer reads from the residual stream and adds its result back.</figcaption>
</figure>

The input and output of a block have exactly the same shape: one vector of size d_model per token. That is what makes stacking possible. GPT-2 small has 12 blocks; the original Transformer had 6 in the encoder and 6 in the decoder; large models use 32 to more than 100. Each block refines the representation a little further. Research suggests early layers tend to handle local and surface features such as word pieces and syntax, while later layers handle more abstract meaning, although the division is not strict.

A complete decoder-only model is then:

1. **Token embedding** (plus position information, unless RoPE is applied inside attention).
2. **N Transformer blocks.**
3. A **final layer norm.**
4. An **output projection** (the "unembedding" or **LM head**) to one logit per vocabulary token, then a softmax to get next-token probabilities.

During **training**, the model sees whole sequences at once. Thanks to the causal mask, a single pass predicts the next token at every position simultaneously, and the loss is the average cross-entropy across all positions. This parallelism is the efficiency advantage that made Transformers so successful.

During **generation**, the model produces one token at a time. It predicts a probability distribution for the next token, picks one (greedily or by sampling, often with a temperature setting), appends it to the sequence, and repeats. Naively, every step would run the whole sequence through all the blocks again. The next section explains how the KV cache avoids most of that work.

Model size follows from these choices. A rough estimate of a standard block's parameters is 12 × d_model²: about 4 × d_model² for the attention projections (W_Q, W_K, W_V and W_O) and 8 × d_model² for a feed-forward network with a 4× expansion. For GPT-2 small, 12 blocks × 12 × 768² is about 85 million parameters, plus about 39 million in the embedding table, for roughly 124 million in total.

## The KV cache {#kv-cache}

When a decoder-only model generates text, it produces one token per step, and each new token attends to all the tokens before it. Without any optimisation, generating the 1,000th token would mean recomputing queries, keys and values for all 999 previous tokens in every layer, even though nothing about them has changed. The **KV cache** removes this waste.

The key observation is that, because of the causal mask, earlier tokens never attend to later ones. So the key and value vectors of a token, at every layer, are fixed once that token has been processed. The model can compute them once, **store** them, and reuse them for every later step. At each new step it only needs to:

1. Compute the query, key and value for the **new token** only.
2. **Append** the new key and value to the cache for each layer.
3. Compare the new query with **all cached keys**, and take the weighted sum of **all cached values**.

Queries do not need to be cached, because only the newest token's query is ever used. This is why it is called a KV cache and not a QKV cache.

Generation therefore has two phases. In the **prefill** phase, the model processes the whole prompt in parallel and fills the cache; this is compute-heavy but efficient. In the **decode** phase, it generates one token at a time, reading the cache each step; this phase is usually limited by **memory bandwidth**, because the GPU must read the entire cache and all the model weights for each new token. The time to the first token depends mostly on prefill; the speed of streaming output depends mostly on decode.

The price of the KV cache is memory. Its size is:

```
2 (K and V) × layers × KV heads × head dimension × sequence length × bytes per value
```

For a model like Llama 2 7B (32 layers, 32 heads of dimension 128, 16-bit values), that is about 0.5 MB per token. A 4,096-token context needs about 2 GB of cache, for each sequence being generated. For long contexts or many users at once, the cache can use more memory than the model weights themselves.

This is why so much engineering targets the KV cache:

- **Grouped-query and multi-query attention** share key and value heads across query heads, shrinking the cache by the same factor (see the multi-head attention section).
- **Quantization** stores cached keys and values in 8 or even 4 bits instead of 16.
- **Paged attention**, used in serving systems such as vLLM, manages the cache in fixed-size blocks like virtual memory pages, reducing waste and letting requests share common prefixes.
- **Prompt (prefix) caching** keeps the cache for a frequently used beginning, such as a long system prompt, so it does not have to be prefilled again for every request.
- **Sliding-window attention** only keeps the most recent tokens in the cache for some layers, limiting its growth.

The KV cache is a pure speed optimisation: with or without it, the model computes exactly the same result. Without it, generating each new token would cost work proportional to the entire sequence in every layer; with it, the expensive per-token projections are done only once, and generation becomes fast enough for interactive use.
