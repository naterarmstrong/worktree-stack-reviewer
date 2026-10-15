import { describe, expect, test } from 'vitest';
import { previewBodyStyle } from '../../src/previewEditor';

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
