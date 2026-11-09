// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { Markdown } from '../src/client/markdown.tsx'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { document.body.replaceChildren() })

async function render(text: string) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Markdown text={text} />) })
  return {
    container,
    dispose: () => { act(() => root.unmount()); container.remove() },
  }
}

it('renders the Markdown chat replies use as React nodes', async () => {
  const view = await render([
    '## Result',
    '',
    'Use **bold**, *italic*, ~~removed~~ and `inline code`.',
    '',
    '- first',
    '- second',
    '',
    '> quoted reply',
    '',
    '```ts',
    'const x = 1 < 2',
    '```',
    '',
    '[docs](https://example.com) and <https://example.org>',
  ].join('\n'))

  const container = view.container
  expect(container.querySelector('h2')?.textContent).toBe('Result')
  expect(container.querySelector('strong')?.textContent).toBe('bold')
  expect(container.querySelector('em')?.textContent).toBe('italic')
  expect(container.querySelector('del')?.textContent).toBe('removed')
  expect(container.querySelector('p code')?.textContent).toBe('inline code')
  expect([...container.querySelectorAll('ul li')].map(item => item.textContent)).toEqual(['first', 'second'])
  expect(container.querySelector('blockquote')?.textContent).toBe('quoted reply')
  expect(container.querySelector('pre code')?.textContent).toBe('const x = 1 < 2')

  const links = [...container.querySelectorAll('a')]
  expect(links.map(link => link.textContent)).toEqual(['docs', 'https://example.org'])
  expect(links.every(link => link.getAttribute('target') === '_blank')).toBe(true)
  expect(links.every(link => link.getAttribute('rel') === 'noopener noreferrer')).toBe(true)
  view.dispose()
})

it('keeps raw HTML and unsafe link targets as text', async () => {
  const view = await render('<img src=x onerror="alert(1)"> and [bad](javascript:alert(1))')
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelector('a')).toBeNull()
  expect(view.container.textContent).toBe('<img src=x onerror="alert(1)"> and [bad](javascript:alert(1))')
  view.dispose()
})

it('preserves authored line breaks and code block whitespace', async () => {
  const view = await render('first line\nsecond line\n\n```\n  indented\n\tand a tab\n```')
  expect([...view.container.querySelectorAll('p br')].length).toBe(1)
  expect(view.container.querySelector('pre code')?.textContent).toBe('  indented\n\tand a tab')
  view.dispose()
})

it('keeps nested list items inside their parent item', async () => {
  const view = await render('- parent\n  - child\n  - sibling child\n- next')
  const outer = view.container.querySelector('.chat-markdown > ul.chat-md-list')!
  const items = [...outer.querySelectorAll(':scope > li')]
  expect(items).toHaveLength(2)
  expect(items[0]?.querySelector(':scope > ul.chat-md-list li')?.textContent).toBe('child')
  expect(items[0]?.querySelector(':scope > ul.chat-md-list')?.textContent).toContain('sibling child')
  expect(items[1]?.textContent).toBe('next')
  view.dispose()
})

it('links bare URLs and leaves ordered lists and headings intact', async () => {
  const view = await render('### Steps\n\n1. Open https://example.com/docs.\n2. Done\n\n---')
  expect(view.container.querySelector('h3')?.textContent).toBe('Steps')
  expect([...view.container.querySelectorAll('ol li')].map(item => item.textContent)).toEqual([
    'Open https://example.com/docs.', 'Done',
  ])
  expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs')
  expect(view.container.querySelector('hr')).not.toBeNull()
  view.dispose()
})
