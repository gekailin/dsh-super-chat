/**
 * Safe Markdown rendering for agent replies.
 *
 * The parser covers the syntax chat replies use (headings, paragraphs, fenced and inline code,
 * lists, quotes, links and inline emphasis) and returns React nodes. It never interprets raw HTML
 * or injects markup strings, so untrusted message text stays text.
 */
import { memo, type ReactNode } from 'react'

const BLANK = /^\s*$/u
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*))?$/u
const RULE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u
const QUOTE = /^ {0,3}> ?(.*)$/u
const UNORDERED = /^ {0,3}[-+*]\s+(.*)$/u
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/u
const LINK = /^\[([^\]\n]*)\]\(\s*([^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/u
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^<>\s]+)>/iu
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/iu
const SAFE_HREF = /^(?:https?:\/\/|mailto:)/iu

const indentOf = (line: string): number => /^ */u.exec(line)![0].length

const isBlockStart = (line: string): boolean =>
  FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) ||
  UNORDERED.test(line) || ORDERED.test(line)

const closingFence = (line: string, marker: string): boolean => {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line)
  return !!match && match[1]![0] === marker[0] && match[1]!.length >= marker.length
}

/** Split a plain text run into text and hard line breaks, preserving authored newlines. */
function textNodes(value: string, base: number): ReactNode[] {
  if (!value.includes('\n')) return [value]
  return value.split('\n').flatMap((part, index, all) =>
    index === all.length - 1 ? [part] : [part, <br key={`br${base}-${index}`} />])
}

const isSpace = (value: string | undefined): boolean => value === undefined || /\s/u.test(value)
const isWord = (value: string | undefined): boolean => value !== undefined && /[\p{L}\p{N}_]/u.test(value)

/** Find a single-character emphasis close that is not part of a double delimiter. */
function emphasisClose(text: string, from: number, marker: string): number {
  let index = from
  while (index < text.length) {
    index = text.indexOf(marker, index)
    if (index === -1) return -1
    if (text[index - 1] !== marker && text[index + 1] !== marker && !isSpace(text[index - 1])) return index
    index += 1
  }
  return -1
}

/**
 * Render inline Markdown to React nodes. Patterns are tried at each position, with code spans and
 * links taking precedence over emphasis so their contents are not rewritten.
 */
function inlineNodes(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let plain = ''
  let index = 0
  let key = 0
  const push = (node: ReactNode): void => {
    if (plain) {
      nodes.push(...textNodes(plain, key))
      plain = ''
    }
    nodes.push(node)
  }
  while (index < text.length) {
    const rest = text.slice(index)
    const char = text[index]!

    if (char === '\\' && index + 1 < text.length) {
      plain += text[index + 1]
      index += 2
      continue
    }

    if (char === '`') {
      const run = /^`+/u.exec(rest)![0]
      const close = text.indexOf(run, index + run.length)
      if (close !== -1) {
        let content = text.slice(index + run.length, close)
        if (content.length > 1 && content.startsWith(' ') && content.endsWith(' ')) content = content.slice(1, -1)
        push(<code key={`code${key++}`}>{content}</code>)
        index = close + run.length
        continue
      }
    }

    if (char === '!' && text[index + 1] === '[') {
      // Images are not fetched from message text; keep the authored syntax visible.
      const match = LINK.exec(text.slice(index + 1))
      if (match) {
        plain += '!' + match[0]
        index += match[0].length + 1
        continue
      }
    }

    if (char === '[') {
      const match = LINK.exec(rest)
      if (match && SAFE_HREF.test(match[2]!)) {
        push(<a key={`link${key++}`} href={match[2]} target="_blank" rel="noopener noreferrer">
          {inlineNodes(match[1]!)}
        </a>)
        index += match[0].length
        continue
      }
    }

    if (char === '<') {
      const match = AUTOLINK.exec(rest)
      if (match && SAFE_HREF.test(match[1]!)) {
        push(<a key={`link${key++}`} href={match[1]} target="_blank" rel="noopener noreferrer">{match[1]}</a>)
        index += match[0].length
        continue
      }
    }

    if ((char === '*' || char === '_' || char === '~') && text[index + 1] === char) {
      const marker = char + char
      const close = text.indexOf(marker, index + 2)
      if (close > index + 2 && !isSpace(text[index + 2]) && !isSpace(text[close - 1])) {
        const content = text.slice(index + 2, close)
        const element = char === '~'
          ? <del key={`del${key++}`}>{inlineNodes(content)}</del>
          : <strong key={`strong${key++}`}>{inlineNodes(content)}</strong>
        push(element)
        index = close + 2
        continue
      }
    }

    if (char === '*' || char === '_') {
      const before = text[index - 1]
      const after = text[index + 1]
      const opening = char === '*' ? !isSpace(after) : !isWord(before) && !isSpace(after)
      if (opening) {
        const close = emphasisClose(text, index + 1, char)
        if (close > index + 1 && !isSpace(text[close - 1])) {
          const content = text.slice(index + 1, close)
          push(<em key={`em${key++}`}>{inlineNodes(content)}</em>)
          index = close + 1
          continue
        }
      }
    }

    if ((char === 'h' || char === 'H') && (index === 0 || !isWord(text[index - 1]))) {
      const match = BARE_URL.exec(rest)
      if (match) {
        let href = match[0]
        const trailing = /[.,;:!?]+$/u.exec(href)
        if (trailing) href = href.slice(0, -trailing[0].length)
        if (href.length > 'https://'.length && SAFE_HREF.test(href)) {
          push(<a key={`link${key++}`} href={href} target="_blank" rel="noopener noreferrer">{href}</a>)
          index += href.length
          continue
        }
      }
    }

    plain += char
    index += 1
  }
  if (plain) nodes.push(...textNodes(plain, key))
  return nodes
}

/** Render one Markdown block stream; `lines` are authored lines without a trailing newline. */
function renderBlocks(lines: readonly string[]): ReactNode[] {
  const nodes: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (BLANK.test(line)) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]!
      const info = fence[2]!.trim().split(/\s+/u)[0] ?? ''
      const content: string[] = []
      index += 1
      while (index < lines.length && !closingFence(lines[index]!, marker)) {
        content.push(lines[index]!)
        index += 1
      }
      if (index < lines.length) index += 1
      const language = /^[\w+-]+$/u.test(info) ? info : undefined
      nodes.push(<pre key={`code${nodes.length}`} className="chat-md-pre" data-lang={language}>
        <code>{content.join('\n')}</code>
      </pre>)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1]!.length)
      const content = inlineNodes(heading[2] ?? '')
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      nodes.push(<Tag key={`heading${nodes.length}`} className="chat-md-heading">{content}</Tag>)
      index += 1
      continue
    }

    if (RULE.test(line)) {
      nodes.push(<hr key={`rule${nodes.length}`} className="chat-md-rule" />)
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]!)
        if (!match) break
        quoted.push(match[1]!)
        index += 1
      }
      nodes.push(<blockquote key={`quote${nodes.length}`} className="chat-md-quote">{renderBlocks(quoted)}</blockquote>)
      continue
    }

    const unordered = UNORDERED.test(line)
    const ordered = !unordered && ORDERED.test(line)
    if (unordered || ordered) {
      const baseIndent = indentOf(line)
      const pattern = ordered ? ORDERED : UNORDERED
      const items: string[][] = []
      while (index < lines.length) {
        const match = pattern.exec(lines[index]!)
        if (!match || indentOf(lines[index]!) !== baseIndent) break
        const body = [ordered ? match[2]! : match[1]!]
        index += 1
        // Keep indented continuation lines, including one nested list level, inside the item.
        while (index < lines.length && !BLANK.test(lines[index]!) && indentOf(lines[index]!) > baseIndent) {
          const indentation = indentOf(lines[index]!)
          body.push(lines[index]!.slice(Math.min(indentation, baseIndent + 2)))
          index += 1
        }
        items.push(body)
        // A blank line between two items of the same level keeps them in one loose list.
        if (index < lines.length && BLANK.test(lines[index]!)) {
          let next = index
          while (next < lines.length && BLANK.test(lines[next]!)) next += 1
          if (next < lines.length && indentOf(lines[next]!) === baseIndent && pattern.test(lines[next]!)) {
            index = next
            continue
          }
          break
        }
      }
      const Tag = ordered ? 'ol' : 'ul'
      const start = ordered ? Number(ORDERED.exec(line)![1]) : undefined
      nodes.push(<Tag key={`list${nodes.length}`} className="chat-md-list" start={start && start !== 1 ? start : undefined}>
        {items.map((item, itemIndex) => <li key={`item${itemIndex}`}>{renderBlocks(item)}</li>)}
      </Tag>)
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && !BLANK.test(lines[index]!) && !isBlockStart(lines[index]!)) {
      paragraph.push(lines[index]!)
      index += 1
    }
    if (paragraph.length === 0) {
      paragraph.push(line)
      index += 1
    }
    nodes.push(<p key={`paragraph${nodes.length}`} className="chat-md-paragraph">{inlineNodes(paragraph.join('\n'))}</p>)
  }
  return nodes
}

/** Render a chat reply's Markdown without ever treating it as HTML. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown">{renderBlocks(text.replace(/\r\n?/gu, '\n').split('\n'))}</div>
})
