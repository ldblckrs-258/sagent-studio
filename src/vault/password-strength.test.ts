import { describe, expect, it } from 'vitest'
import { MIN_PASSWORD_LENGTH, scorePassword } from './password-strength'

describe('scorePassword', () => {
  it('refuses to grade anything below the length the form enforces', () => {
    expect(scorePassword('Aa1!')).toMatchObject({ score: 0, label: 'Too short', tone: 'danger' })
    expect(scorePassword('A'.repeat(MIN_PASSWORD_LENGTH - 1)).score).toBe(0)
  })

  it('calls a single character class weak no matter how long it is', () => {
    expect(scorePassword('12345678')).toMatchObject({ score: 1, label: 'Weak' })
    expect(scorePassword('abcdefghijklmnop').label).toBe('Fair')
  })

  it('ranks passwords strictly higher as character classes are added', () => {
    const score = (password: string) => scorePassword(password).score
    expect(score('abcdefgh')).toBeLessThan(score('Abcdefgh'))
    expect(score('Abcdefgh')).toBeLessThan(score('Abcdefg1'))
  })

  it('withholds the top grade from a short password however varied it is', () => {
    expect(scorePassword('Abcdef1!')).toMatchObject({ score: 3, label: 'Strong' })
  })

  it('grants the top grade only to a long and varied password', () => {
    expect(scorePassword('Abcdefghijk1')).toMatchObject({
      score: 4,
      label: 'Very strong',
      tone: 'positive',
    })
  })

  it('flags the middle grades as caution so the meter warns instead of reassuring', () => {
    expect(scorePassword('abcdefghijkl')).toMatchObject({ score: 2, tone: 'caution' })
    expect(scorePassword('Abcdefgh').tone).toBe('caution')
  })
})
