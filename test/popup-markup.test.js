import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'parse5';
import test from 'node:test';

const popupHtml = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
const popupJs = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
const parseErrors = [];
const document = parse(popupHtml, {
  onParseError(error) {
    parseErrors.push(error);
  }
});

function collectNodes(node, results = []) {
  results.push(node);
  for (const child of node.childNodes || []) collectNodes(child, results);
  if (node.content) collectNodes(node.content, results);
  return results;
}

function getTextContent(node) {
  if (node.nodeName === '#text') return node.value;
  return (node.childNodes || []).map(getTextContent).join('');
}

const nodes = collectNodes(document);
const getByIdReferences = [...popupJs.matchAll(/document\.getElementById\(['"]([^'"]+)['"]\)/g)]
  .map((match) => match[1]);

test('popup.html parses as valid HTML5 with one head and body', () => {
  assert.deepEqual(parseErrors, []);
  assert.equal(nodes.filter((node) => node.tagName === 'head').length, 1);
  assert.equal(nodes.filter((node) => node.tagName === 'body').length, 1);
});

test('popup.html contains exactly one popup.js module script', () => {
  const popupScripts = nodes.filter((node) =>
    node.tagName === 'script' &&
    node.attrs?.some((attribute) => attribute.name === 'src' && attribute.value === 'popup.js')
  );

  assert.equal(popupScripts.length, 1);
  assert.ok(popupScripts[0].attrs.some((attribute) =>
    attribute.name === 'type' && attribute.value === 'module'
  ));
});

test('every popup.js getElementById reference exists exactly once in popup.html', () => {
  const idCounts = new Map();
  for (const node of nodes) {
    const id = node.attrs?.find((attribute) => attribute.name === 'id')?.value;
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
  }

  for (const id of getByIdReferences) {
    assert.equal(idCounts.get(id), 1, `Expected exactly one element with id="${id}"`);
  }
});

test('popup labels aggregate totals separately from recent activity', () => {
  const text = getTextContent(document);
  assert.match(text, /Total blocked/);
  assert.match(text, /Total detected/);
  assert.match(text, /Recent activity/);
});