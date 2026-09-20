import { describe, expect, it } from 'vitest'
import { fileLookFor, folderLookFor } from './file-icon'

describe('folderLookFor', () => {
  it('shows an open folder only while the directory is expanded', () => {
    expect(folderLookFor(true).Icon).not.toBe(folderLookFor(false).Icon)
    expect(folderLookFor(true).Icon.displayName).toBe('FolderOpen')
    expect(folderLookFor(false).Icon.displayName).toBe('Folder')
  })
})

describe('fileLookFor', () => {
  it('colours the kinds the viewer already knows about', () => {
    expect(fileLookFor('assets/logo.png').className).toBe('text-file-media')
    expect(fileLookFor('clip.mp4').className).toBe('text-file-media')
    expect(fileLookFor('theme.mp3').className).toBe('text-file-media')
    expect(fileLookFor('data/rows.csv').className).toBe('text-file-sheet')
    expect(fileLookFor('book.xlsx').className).toBe('text-file-sheet')
    expect(fileLookFor('tsconfig.json').className).toBe('text-file-data')
    expect(fileLookFor('README.md').className).toBe('text-muted')
  })

  it('splits the kinds the viewer lumps together as text', () => {
    expect(fileLookFor('src/main.ts').className).toBe('text-file-code')
    expect(fileLookFor('app/styles.scss').className).toBe('text-file-code')
    expect(fileLookFor('docker-compose.yml').className).toBe('text-file-data')
    expect(fileLookFor('pnpm-lock.yaml').className).toBe('text-file-data')
    expect(fileLookFor('release.tar.gz').className).toBe('text-faint')
  })

  it('gives an unknown or extensionless file the neutral look', () => {
    expect(fileLookFor('LICENSE')).toEqual(fileLookFor('notes.unknownext'))
    expect(fileLookFor('LICENSE').className).toBe('text-faint')
  })

  it('reads the extension, not the folder names above it', () => {
    expect(fileLookFor('images/png/build.ts').className).toBe('text-file-code')
  })

  it('ignores extension casing', () => {
    expect(fileLookFor('Photo.PNG').className).toBe('text-file-media')
  })
})
