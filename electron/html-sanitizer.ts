import sanitizeHtml from 'sanitize-html';

const COLOR_PATTERNS = [/^#[0-9a-fA-F]{3,8}$/, /^rgb\((\s*\d+\s*,){2}\s*\d+\s*\)$/i, /^rgba\((\s*\d+\s*,){3}\s*(0|1|0?\.\d+)\s*\)$/i];

const NOTE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'article',
    'b',
    'blockquote',
    'br',
    'code',
    'col',
    'colgroup',
    'div',
    'em',
    'figure',
    'figcaption',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    's',
    'section',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'u',
    'ul'
  ],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'style', 'class', 'data-*'],
    td: ['colspan', 'rowspan', 'style', 'class', 'data-*'],
    th: ['colspan', 'rowspan', 'style', 'class', 'data-*'],
    figure: ['style', 'class', 'data-*'],
    figcaption: ['style', 'class', 'data-*'],
    div: ['style', 'class', 'data-*'],
    section: ['style', 'class', 'data-*'],
    span: ['style', 'class', 'data-*'],
    p: ['style', 'class', 'data-*'],
    table: ['style', 'class', 'data-*'],
    tbody: ['style', 'class', 'data-*'],
    thead: ['style', 'class', 'data-*'],
    tr: ['style', 'class', 'data-*'],
    '*': ['style', 'class', 'data-*']
  },
  allowedSchemes: ['http', 'https', 'file', 'data', 'blob'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  allowedStyles: {
    '*': {
      color: COLOR_PATTERNS,
      'background-color': COLOR_PATTERNS,
      'font-size': [/^\d+(px|em|rem|%)$/i],
      'text-align': [/^(left|right|center|justify)$/i]
    }
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
  }
};

export function sanitizeNoteHtml(html: string) {
  const sanitized = sanitizeHtml(html || '<p></p>', NOTE_SANITIZE_OPTIONS).trim();
  return sanitized || '<p></p>';
}