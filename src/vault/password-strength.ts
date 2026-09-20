export const MIN_PASSWORD_LENGTH = 8

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4
export type PasswordStrengthTone = 'danger' | 'caution' | 'positive'

export interface PasswordStrength {
  score: PasswordStrengthScore
  label: string
  tone: PasswordStrengthTone
}

const LABELS: Record<PasswordStrengthScore, string> = {
  0: 'Too short',
  1: 'Weak',
  2: 'Fair',
  3: 'Strong',
  4: 'Very strong',
}

const TONES: Record<PasswordStrengthScore, PasswordStrengthTone> = {
  0: 'danger',
  1: 'danger',
  2: 'caution',
  3: 'positive',
  4: 'positive',
}

const LONG_PASSWORD_LENGTH = 12

const CHARACTER_CLASSES = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]

export function scorePassword(password: string): PasswordStrength {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { score: 0, label: LABELS[0], tone: TONES[0] }
  }

  const variety = CHARACTER_CLASSES.filter((pattern) => pattern.test(password)).length
  const long = password.length >= LONG_PASSWORD_LENGTH
  const score = Math.min(variety + (long ? 1 : 0), long ? 4 : 3) as PasswordStrengthScore

  return { score, label: LABELS[score], tone: TONES[score] }
}
