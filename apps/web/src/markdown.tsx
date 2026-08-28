import type { JSX } from 'react';

function inline(text: string): JSX.Element[] {
  const parts: JSX.Element[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(<span key={key++}>{text.slice(last, match.index)}</span>);
    }
    const token = match[0];
    if (token.startsWith('**')) parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return parts;
}

function splitRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

export function Markdown({ source }: { source: string }) {
  const lines = source.split('\n');
  const out: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    if (line.startsWith('#')) {
      const level = Math.min(3, (line.match(/^#+/)?.[0].length ?? 1));
      const text = line.replace(/^#+\s*/, '');
      if (level === 1) out.push(<h1 key={key++}>{inline(text)}</h1>);
      else if (level === 2) out.push(<h2 key={key++}>{inline(text)}</h2>);
      else out.push(<h3 key={key++}>{inline(text)}</h3>);
      i += 1;
      continue;
    }

    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        quote.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      out.push(<blockquote key={key++}>{inline(quote.join(' '))}</blockquote>);
      continue;
    }

    if (line.trim().startsWith('|') && lines[i + 1]?.includes('---')) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(splitRow(lines[i]!));
        i += 1;
      }
      out.push(
        <div className="table-wrap paper" key={key++}>
          <table>
            <thead>
              <tr>{head.map((h, j) => <th key={j} scope="col">{inline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^[-*]\s/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^[-*]\s/, ''));
        i += 1;
      }
      out.push(<ul key={key++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim().length > 0 &&
      !lines[i]!.startsWith('#') &&
      !lines[i]!.startsWith('>') &&
      !lines[i]!.trim().startsWith('|') &&
      !/^[-*]\s/.test(lines[i]!.trim())
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    out.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }

  return <div className="md">{out}</div>;
}
