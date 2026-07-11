import React, { useMemo } from 'react';

interface Props {
  text: string;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Lightweight Markdown renderer for gateway messages.
 * Supports: bold, italic, inline code, code blocks, unordered/ordered lists,
 * blockquotes, headings, paragraphs, line breaks.
 */
export const MdText: React.FC<Props> = ({ text, className, style }) => {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={className}
      style={{
        ...style,
        lineHeight: 1.6,
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInline(src: string): string {
  return src
    .replace(/`([^`]+)`/g, '<code style="padding:1px 4px;border-radius:4px;background:rgba(99,102,241,0.12);font-family:JetBrains Mono,monospace;font-size:0.92em;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let inList = false;
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (!inList || !listType) return;
    out.push(`</${listType}>`);
    inList = false;
    listType = null;
  };

  const openList = (type: 'ul' | 'ol') => {
    if (inList && listType === type) return;
    closeList();
    out.push(`<${type} style="margin:6px 0;padding-left:18px;">`);
    inList = true;
    listType = type;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (line.startsWith('```')) {
      if (inCode) {
        const code = escapeHtml(codeLines.join('\n'));
        out.push(
          `<pre style="margin:8px 0;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.25);overflow-x:auto;"><code style="font-family:JetBrains Mono,monospace;font-size:0.92em;line-height:1.5;">${code}</code></pre>`
        );
        inCode = false;
        codeLines = [];
      } else {
        closeList();
        inCode = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === '') {
      closeList();
      continue;
    }

    // Headings
    if (/^#{1,6}\s+/.test(trimmed)) {
      closeList();
      const level = trimmed.match(/^(#{1,6})\s+/)![1].length;
      const size = Math.max(13, 20 - level * 2);
      const content = renderInline(trimmed.replace(/^#{1,6}\s+/, ''));
      out.push(`<h${level} style="margin:10px 0 6px;font-size:${size}px;font-weight:600;">${content}</h${level}>`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      closeList();
      const content = renderInline(trimmed.slice(2));
      out.push(`<blockquote style="margin:6px 0;padding:6px 12px;border-left:3px solid var(--hone-primary,#6366F1);background:rgba(99,102,241,0.08);border-radius:0 6px 6px 0;">${content}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      openList('ul');
      const content = renderInline(trimmed.replace(/^[-*+]\s+/, ''));
      out.push(`<li style="margin:3px 0;">${content}</li>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      openList('ol');
      const content = renderInline(trimmed.replace(/^\d+\.\s+/, ''));
      out.push(`<li style="margin:3px 0;">${content}</li>`);
      continue;
    }

    closeList();

    // Paragraph
    const content = renderInline(trimmed);
    out.push(`<p style="margin:6px 0;">${content}</p>`);
  }

  if (inCode) {
    const code = escapeHtml(codeLines.join('\n'));
    out.push(
      `<pre style="margin:8px 0;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.25);overflow-x:auto;"><code style="font-family:JetBrains Mono,monospace;font-size:0.92em;line-height:1.5;">${code}</code></pre>`
    );
  }

  closeList();
  return out.join('');
}

export default MdText;
