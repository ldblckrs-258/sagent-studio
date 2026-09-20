function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

export function compileGlob(pattern: string): RegExp | null {
  if (typeof pattern !== 'string') return null
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '/') {
      source += '/'
    } else {
      source += escapeRegExpChar(char)
    }
  }
  source += '$'
  try {
    return new RegExp(source)
  } catch {
    return null
  }
}

export function matchesGlob(pattern: string, path: string): boolean {
  if (typeof path !== 'string') return false
  const regex = compileGlob(pattern)
  if (!regex) return false
  return regex.test(path)
}
