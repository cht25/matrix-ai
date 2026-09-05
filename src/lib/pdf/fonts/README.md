# MATRIX PDF fonts

These TrueType files are embedded (as subsets) into every PDF the platform
generates. They exist because the PDF "standard 14" Type 1 fonts are Latin-1
only and cannot represent Bangla, most punctuation or symbols — which is what
made earlier exports come out blank or garbled.

| File                        | Upstream font       | Covers                                                   |
| --------------------------- | ------------------- | -------------------------------------------------------- |
| `MatrixSans-Regular.ttf`    | DejaVu Sans         | Latin, Greek, Cyrillic, punctuation, arrows, maths, ✓ • → |
| `MatrixSans-Bold.ttf`       | DejaVu Sans Bold    | as above, bold                                            |
| `MatrixMono-Regular.ttf`    | DejaVu Sans Mono    | monospaced code and IDs                                   |
| `MatrixMono-Bold.ttf`       | DejaVu Sans Mono Bold | as above, bold                                          |
| `MatrixBengali-Regular.ttf` | Noto Sans Bengali   | Bengali/Bangla, including conjuncts and vowel reordering  |
| `MatrixBengali-Bold.ttf`    | Noto Sans Bengali Bold | as above, bold                                         |

## Licences

- **DejaVu fonts** — DejaVu Fonts Licence (a permissive, Bitstream Vera-derived
  licence). Free to use, embed, modify and redistribute.
- **Noto Sans Bengali** — SIL Open Font Licence 1.1. Free to use, embed, modify
  and redistribute; embedding in documents is explicitly permitted.

Both licences permit redistribution and document embedding, which is exactly how
they are used here.

## Adding coverage for another script

1. Drop the `.ttf` in this directory.
2. Add it to `FILES` in `../fonts.ts` and give it a `FaceName`.
3. Extend `faceForChar` so characters in that script prefer the new face.

Coverage is read from each font's own `cmap` at runtime, so nothing else needs
to be kept in sync — and `tests/pdf-engine.test.ts` will fail loudly if a
character ends up with no face at all.
