/**
 * Vietnamese text repair shared by extraction and matching.
 *
 * A geometric PDF extractor can drop a space inside a syllable (`quyề n` →
 * `quyề n`) when glyph widths are underreported. NFC composes the diacritic but
 * leaves the injected space, so a correctly written quotation can never match a
 * corrupted passage deterministically. This rejoins a space that sits after a
 * vowel and before a following coda or vowel of the same syllable.
 *
 * The rule is deliberately narrow. It only fires when the fragment after the
 * space is a Vietnamese coda (`c ch m n ng nh p t`) or a single vowel that ends a
 * syllable, so a real word boundary such as `Bộ trưởng` or `đã ra` is left
 * intact. It is applied to both sides of a comparison, so even when it joins a
 * boundary it does so consistently and matching is preserved.
 */

const VI_VOWELS =
  'aàáảãạăằắẳẵặâầấẩẫậeèéẻẽẹêềếểễệiìíỉĩịoòóỏõọôồốổỗộơờớởỡợuùúủũụưừứửữựyỳýỷỹỵ'

/**
 * The fragment after the space must be a Vietnamese coda (`c ch m n ng nh p t`)
 * or a single vowel that ends its syllable. A vowel followed by an optional coda
 * is deliberately *not* accepted: `em`, `ăn`, `ông` are real words, so accepting
 * them would merge `và em`. The cost is that a split before a two-letter
 * vowel-plus-coda fragment (`nư ớc`) is left alone.
 */
const VI_CODA = 'c|ch|m|n|ng|nh|p|t'

const SYLLABLE_SPLIT = new RegExp(
  `([${VI_VOWELS}])\\s+(?=(?:[${VI_VOWELS}]|${VI_CODA})(?=\\s|$|[^\\p{L}]))`,
  'giu',
)

export function normalizeVietnameseSyllableSplits(value: string): string {
  return value.replace(SYLLABLE_SPLIT, '$1')
}
