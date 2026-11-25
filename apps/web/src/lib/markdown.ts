import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, definition] of Object.entries({ bash, css, go, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, definition)
}

const escape = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

const parser = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: token => escape(token.text),
    image: token => `<span>${escape(token.text || '图片')}</span>`,
    link(token) {
      return `<a href="${escape(token.href)}" target="_blank" rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`
    },
    code({ lang, text }) {
      const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase()
      const supported = Boolean(language && hljs.getLanguage(language))
      const body = supported ? hljs.highlight(text, { language, ignoreIllegals: true }).value : escape(text)
      return `<div class="code-frame"><div class="code-heading"><span>${escape(language || '代码')}</span><button type="button" class="code-copy">复制</button></div><pre><code class="hljs">${body}</code></pre></div>`
    },
  },
  extensions: [{
    name: 'mention',
    level: 'inline',
    start(src) {
      const match = /(?:^|\s)(@[a-z0-9_-]{2,32})(?![a-z0-9_-])/i.exec(src)
      return match ? match.index + (match[0].length - match[1].length) : undefined
    },
    tokenizer(src) {
      const match = /^@([a-z0-9_-]{2,32})(?![a-z0-9_-])/i.exec(src)
      return match ? { type: 'mention', raw: match[0], text: match[0] } : undefined
    },
    renderer(token) { return `<span class="mention">${escape(String(token.text))}</span>` },
  }],
})

const MAX_RENDER_CACHE = 300
const MAX_CACHE_INPUT = 40_000
const renderCache = new Map<string, string>()

export function renderMarkdown(content: string) {
  if (content.length <= MAX_CACHE_INPUT) {
    const cached = renderCache.get(content)
    if (cached !== undefined) {
      renderCache.delete(content)
      renderCache.set(content, cached)
      return cached
    }
  }
  const html = DOMPurify.sanitize(parser.parse(content, { async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'span', 'a', 'div', 'blockquote', 'pre', 'code', 'strong', 'em', 'del', 'b', 'i',
      'ul', 'li', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'button'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'start', 'type', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|\/(?!\/)|#)/i,
  })
  if (content.length <= MAX_CACHE_INPUT) {
    if (renderCache.size >= MAX_RENDER_CACHE) {
      const oldest = renderCache.keys().next().value
      if (oldest !== undefined) renderCache.delete(oldest)
    }
    renderCache.set(content, html)
  }
  return html
}

export function markdownSummary(content: string) {
  const firstLine = content.trim().split(/\r?\n/, 1)[0].replace(/^#{1,6}\s+/, '').slice(0, 240)
  const fragment = DOMPurify.sanitize(parser.parseInline(firstLine, { async: false }), {
    ALLOWED_TAGS: [], RETURN_DOM_FRAGMENT: true,
  })
  return fragment.textContent?.trim() ?? ''
}
