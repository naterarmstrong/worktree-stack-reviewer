import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from 'vitest';
import { Uri } from 'vscode';
import {
  PREVIEW_CSP,
  pageTitle,
  parseHtmlPreviewLink,
  withPreviewHead,
} from '../../src/htmlPreview';

const EXTENSION_ID = 'naterarmstrong.worktree-stack-reviewer';
const link = (p: string) =>
  Uri.parse(`vscode://${EXTENSION_ID}/preview?path=${encodeURIComponent(p)}`);

describe('preview links', () => {
  test('reads a percent-encoded page in a wt-review directory', () => {
    const p = '/private/tmp/claude-501/x/scratchpad/wt-review/pr-46584.local.html';
    expect(parseHtmlPreviewLink(link(p))).toEqual({ path: p });
  });

  test('refuses anything but an .html file directly in wt-review', () => {
    for (const p of [
      '/Users/me/.ssh/id_rsa',
      '/tmp/wt-review/notes.txt',
      '/tmp/wt-review/sub/page.html',
      '/tmp/not-wt-review/page.html',
      '/tmp/wt-review/../secrets/wt-review/page.html',
      'wt-review/page.html',
    ]) {
      expect(parseHtmlPreviewLink(link(p)), p).toHaveProperty('rejected');
    }
    expect(parseHtmlPreviewLink(Uri.parse(`vscode://${EXTENSION_ID}/preview`))).toHaveProperty(
      'rejected',
    );
  });

  test('other paths are not preview links', () => {
    expect(parseHtmlPreviewLink(Uri.parse(`vscode://${EXTENSION_ID}/compare?branch=b`))).toBeUndefined();
  });
});

describe('page html', () => {
  test('the CSP and bridge go first in the head, before the page loads anything', () => {
    const html = withPreviewHead(
      '<!doctype html><html><head lang="en"><link href="https://fonts.googleapis.com/x"></head><body></body></html>',
    );
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('fonts.googleapis'));
    expect(html.indexOf('<head lang="en">')).toBeLessThan(html.indexOf('Content-Security-Policy'));
    expect(html).toContain('acquireVsCodeApi');
  });

  test('a page without a head gets one after its doctype', () => {
    const html = withPreviewHead('<!DOCTYPE html><p>hi</p>');
    expect(html.startsWith('<!DOCTYPE html>\n<head>')).toBe(true);
  });

  test('the CSP opens exactly the sources the explainers use, and no connections', () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain('https://fonts.gstatic.com');
    expect(PREVIEW_CSP).toContain('https://unpkg.com');
    expect(PREVIEW_CSP).not.toContain('connect-src');
  });

  test('the comment UI joins the bridge only on a page whose PR is known', () => {
    const page = '<!doctype html><html><head></head><body><p>hi</p></body></html>';
    expect(withPreviewHead(page)).not.toContain('wtExplainerComments');

    const ui = 'function wtExplainerComments(vscode) { vscode.postMessage({ type: "ready" }); }';
    const html = withPreviewHead(page, ui);
    // Inside the closure that holds the webview API, and run there.
    const bridge = html.slice(html.indexOf('acquireVsCodeApi'), html.indexOf('</script>'));
    expect(bridge).toContain(ui);
    expect(bridge).toContain('wtExplainerComments(vscode);');
    expect(html.match(/acquireVsCodeApi\(/g)).toHaveLength(1);
    expect(html).toContain(PREVIEW_CSP);
  });

  test('the shipped comment UI can be inlined in a script tag', () => {
    const ui = fs.readFileSync(path.join(__dirname, '../../media/explainer-comments.js'), 'utf8');
    expect(ui).toMatch(/^function wtExplainerComments\(vscode\)/m);
    expect(ui).not.toMatch(/<\/script/i);
  });

  test('titles are decoded and trimmed, and a blank one is no title', () => {
    expect(pageTitle('<title>\n  PR #46584 &amp; friends </title>')).toBe('PR #46584 & friends');
    expect(pageTitle('<title> </title>')).toBeUndefined();
    expect(pageTitle('<p>none</p>')).toBeUndefined();
  });
});
