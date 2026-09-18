import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SecretField } from './secret-field'

const SEEDED_KEY = 'SEEDED_PLAINTEXT_SECRET_1234567890'

describe('SecretField', () => {
  it('does not render the stored secret into the DOM before reveal', () => {
    const html = renderToStaticMarkup(
      <SecretField name="api-key" storedValue={SEEDED_KEY} onChange={() => {}} />,
    )
    expect(html).not.toContain(SEEDED_KEY)
    expect(html).toContain('type="password"')
    expect(html).toContain('••')
  })

  it('renders an empty field when no secret is stored', () => {
    const html = renderToStaticMarkup(
      <SecretField name="api-key" storedValue="" onChange={() => {}} />,
    )
    expect(html).not.toContain('••')
  })
})
