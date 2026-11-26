# wordfreq data attribution

The table in "wordfreq-en.ts" is derived from the **small English wordlist** of
[wordfreq](https://github.com/rspeer/wordfreq) by Robyn Speer.

- wordfreq **code**: Apache License 2.0. No wordfreq code is bundled here; the
  generator (scripts/build-word-frequency.mjs) only reads the published data.
- wordfreq **data**: **CC BY-SA 4.0**
  (https://creativecommons.org/licenses/by-sa/4.0/).

## What was done to the data

1. Read wordfreq/data/small_en.msgpack.gz (cBpack v1: alphabetical word lists,
   one list per centibel bucket). A word in bucket i has zipf = (900 - i) / 100.
2. Normalized each word the same way perception does (NFKC, lowercase, unified
   apostrophes, edge punctuation removed) and dropped anything longer than 64
   characters or containing whitespace.
3. Sorted alphabetically and front-coded: each line stores only the suffix that
   differs from the previous word, plus the Zipf value quantized to centibels
   and written in base 36.

No frequencies were invented, smoothed or blended; the table is a re-encoding
of the source values. It is therefore a **derivative of CC BY-SA 4.0 data** and
is distributed under the same license.

## ShareAlike in practice

- Keep this notice and the license reference with the data.
- If you redistribute a modified table (as wordfreq-en.ts or another encoding),
  that modified table must also be CC BY-SA 4.0, and must state that it is a
  derivative.
- The rest of Xrawl (code, UI, other data) is not forced under CC BY-SA by
  including this table; ShareAlike applies to the licensed data and its
  derivatives. Review this before publishing a build: it is a licensing
  decision, not a code decision.
- The table is optional at runtime: frequency.ts falls back to a neutral rarity
  for unknown words, so replacing or removing the data does not break gameplay,
  it only makes rarity scoring less informative.

## Regenerating

    # Download the source once (28,917 words, zipf >= 3.0):
    curl -L -o /tmp/small_en.msgpack.gz \
      https://raw.githubusercontent.com/rspeer/wordfreq/master/wordfreq/data/small_en.msgpack.gz

    npm run build:wordfreq -- /tmp/small_en.msgpack.gz

The generator is deterministic: the same input always produces the same file.
