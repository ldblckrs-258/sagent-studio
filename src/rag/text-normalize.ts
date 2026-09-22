/**
 * Vietnamese text repair shared by extraction and matching.
 *
 * A geometric PDF extractor corrupts spacing in two opposite ways. It drops a
 * space inside a syllable (`quyề n` → `quyền`, `nư ớc` → `nước`) when glyph
 * widths are underreported, and it omits the space between two syllables that
 * are shown as separate glyph runs (`lợi ích` → `lợiích`). This module repairs
 * both using the syllable grammar, so a correctly written quotation can match a
 * repaired passage deterministically.
 *
 * The merge direction only fires when the joined text is one valid Vietnamese
 * syllable, which is what leaves a real word boundary such as `Bộ trưởng`,
 * `đã ra` or `có ăn` intact. The split direction only fires on a run that is not
 * itself a valid syllable but divides into exactly two valid ones, which is what
 * repairs `lợiích` without mangling an English or loan word.
 */

import {
  isSingleCoda,
  isValidSyllable,
  isValidSyllableBase,
  startsWithToneMarkedVowel,
  toBaseSyllable,
} from './vietnamese-syllable'

const WORD = /^\p{L}+$/u

/**
 * A split is rejoined when the two halves form one valid syllable and the right
 * half is a plausible continuation: a tone-marked vowel fragment (`ớc`, `ủa`,
 * `ều`, `ản`), a bare coda (`n`, `ng`), or a single letter that completes the
 * syllable (`nghĩ` + `a`, `hộ` + `i`). A two-letter plain-vowel half (`em`,
 * `ai`, `ăn`) is refused, so `và em`, `có ai` and `có ăn` keep their boundary.
 */
function shouldRejoin(previous: string, piece: string): boolean {
  if (!WORD.test(previous) || !WORD.test(piece)) return false
  if (piece.length > 3) return false
  if (!isValidSyllable(previous + piece)) return false
  if (startsWithToneMarkedVowel(piece)) return true
  if (isSingleCoda(piece)) return true
  return piece.length <= 1
}

export function normalizeVietnameseSyllableSplits(value: string): string {
  const pieces = value.match(/\s+|\S+/gu)
  if (pieces === null) return value

  let result = ''
  let pending = ''
  let previous = ''

  for (const piece of pieces) {
    if (/^\s/u.test(piece)) {
      pending += piece
      continue
    }
    const rejoin =
      previous !== '' &&
      pending !== '' &&
      !pending.includes('\n') &&
      shouldRejoin(previous, piece)
    if (rejoin) {
      result += piece
      previous += piece
    } else {
      result += pending + piece
      previous = piece
    }
    pending = ''
  }
  return result + pending
}

/**
 * Splits a run that is not a valid syllable but is exactly two valid syllables
 * glued together, trying the shortest first half first so `chủnghĩa` resolves to
 * `chủ nghĩa` (not `chủng hĩa`) and `củatôi` to `của tôi`. Runs without a
 * Vietnamese diacritic are left alone, which keeps English and identifier tokens
 * (`page`, `worker`, `vbhn`) out of the repair.
 */
function splitRun(run: string): string | null {
  if (!hasVietnameseDiacritic(run)) return null
  const base = toBaseSyllable(run)
  for (let cut = 1; cut < run.length; cut++) {
    if (isValidSyllableBase(base.slice(0, cut)) && isValidSyllableBase(base.slice(cut))) {
      return `${run.slice(0, cut)} ${run.slice(cut)}`
    }
  }
  return null
}

/** True when the run carries a non-ASCII character, i.e. a Vietnamese diacritic. */
function hasVietnameseDiacritic(run: string): boolean {
  for (const char of run) if (char.charCodeAt(0) > 127) return true
  return false
}

export function repairMissingSyllableSpaces(value: string): string {
  return value.normalize('NFC').replace(/[\p{L}]{3,}/gu, (run) =>
    isValidSyllable(run) ? run : (splitRun(run) ?? run),
  )
}
