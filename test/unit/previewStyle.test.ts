import { describe, expect, test } from 'vitest';
import { previewBodyStyle, resolveLink } from '../../src/previewEditor';

describe('preview typography', () => {
  test('renders at GitHub’s size and leading when nothing is configured', () => {
    const style = previewBodyStyle({ fontFamily: '', columnWidth: 900 });

    expect(style).toContain('--markdown-font-size: 16px;');
    expect(style).toContain('--markdown-line-height: 1.5;');
    expect(style).toContain('--wt-column-width: 900px;');
  });

  test('a built-in preview setting the user chose wins over the default', () => {
    const style = previewBodyStyle({
      fontFamily: 'Fira Sans',
      fontSize: 13,
      lineHeight: 1.8,
      columnWidth: 900,
    });

    expect(style).toContain('--markdown-font-family: Fira Sans;');
    expect(style).toContain('--markdown-font-size: 13px;');
    expect(style).toContain('--markdown-line-height: 1.8;');
  });

  test('a width of zero leaves the page full width', () => {
    const style = previewBodyStyle({ fontFamily: '', columnWidth: 0 });

    expect(style).not.toContain('--wt-column-width');
  });
});

describe('resolveLink', () => {
  test('resolves a relative link against the root, keeping its heading', () => {
    const target = resolveLink('/repo/docs', '../guide/a%20b.md#setup');

    expect(target?.uri.fsPath).toBe('/repo/guide/a b.md');
    expect(target?.fragment).toBe('setup');
  });

  test('a relative link with no root points nowhere', () => {
    expect(resolveLink(undefined, './a.md')).toBeUndefined();
  });

  test('reads the heading off a file URI', () => {
    const target = resolveLink('/repo', 'file:///repo/a.md#setup');

    expect(target?.uri.fsPath).toBe('/repo/a.md');
    expect(target?.fragment).toBe('setup');
  });

  test('leaves an external link alone', () => {
    const target = resolveLink('/repo', 'https://example.com/a.md#setup');

    expect(target?.uri.toString()).toBe('https://example.com/a.md#setup');
  });
});
