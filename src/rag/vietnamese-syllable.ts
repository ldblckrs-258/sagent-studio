/**
 * Vietnamese syllable grammar.
 *
 * A geometric PDF extractor drops a space inside a syllable (`quyề n` → `quyề n`,
 * `nư ớc`) and, more rarely, glues two syllables that should be separate
 * (`lợiích`). Both repairs are safe only if they can tell a well-formed
 * Vietnamese syllable from two real words that happen to meet at a space
 * (`và em`, `đã ra`, `có ăn`). A repair that joins two words is worse than the
 * defect it was meant to fix, so both directions ask this module first.
 *
 * A syllable is optional onset + rhyme (nucleus + optional coda). Validation is
 * done on the base letters (tone stripped) because tone placement does not
 * change the letters; a separate tone count rejects a run that carries two tone
 * marks, which is never a single syllable (`tựý` is two, `tuy` is one).
 */

/** Every vowel that carries one of the five tones (breve/circumflex/horn excluded). */
const TONED_VOWELS =
  'àáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ'

const CODA = 'ch|ng|nh|c|m|n|p|t'

const ONSET = 'ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|b|c|d|g|h|k|l|m|n|p|r|s|t|v|x'

/**
 * Nuclei, longest first so the alternation consumes the whole cluster before
 * falling back to a single vowel. `uo` stands for both `uô` and `ươ`; `oo` is
 * only there for loanwords (`xoong`). `ae`/`ao`-style sequences that are not
 * real Vietnamese nuclei are deliberately absent, which is what rejects a
 * coincidental join such as `và em` → `vaem`.
 */
const NUCLEUS =
  'uyu|uye|uya|uou|uoi|uay|oai|oao|oay|ieu|yeu|ai|ao|au|ay|eo|eu|ia|ie|iu|oa|oe|oo|oi|ua|ue|ui|uo|uy|ye|a|e|i|o|u|y'

const SYLLABLE = new RegExp(`^(?:${ONSET})?(?:${NUCLEUS})(?:${CODA})?$`)
const SINGLE_CODA = new RegExp(`^(?:${CODA})$`)

/**
 * Maps a Vietnamese word to its base letters: NFD, drop every combining mark,
 * fold `đ`, lowercase. Every precomposed Vietnamese character decomposes to
 * exactly one base letter, so the result has the same length as the input — the
 * caller relies on that to slice the original string by base offsets.
 */
export function toBaseSyllable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/giu, 'd')
    .toLowerCase()
}

/** Shape test only; the caller supplies an already de-toned string. */
export function isValidSyllableBase(base: string): boolean {
  return base.length > 0 && SYLLABLE.test(base)
}

function countTonedVowels(value: string): number {
  let count = 0
  for (const char of value.normalize('NFC')) if (TONED_VOWELS.includes(char)) count += 1
  return count
}

/** True when the token is one well-formed Vietnamese syllable (at most one tone). */
export function isValidSyllable(value: string): boolean {
  return isValidSyllableBase(toBaseSyllable(value)) && countTonedVowels(value) <= 1
}

/** True when the first character is a vowel already carrying a tone mark. */
export function startsWithToneMarkedVowel(value: string): boolean {
  return TONED_VOWELS.includes(value.charAt(0))
}

/** True when the token is exactly one Vietnamese coda (`n`, `ng`, `nh`, …). */
export function isSingleCoda(value: string): boolean {
  return SINGLE_CODA.test(toBaseSyllable(value))
}
