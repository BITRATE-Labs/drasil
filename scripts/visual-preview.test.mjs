import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const marker = '<!-- drasil-snapshot-preview-comment -->';
const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runPreview(file, { labeled = true, head = 'event-head', comments = [] } = {}) {
  const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
  const match = workflow.match(/^ {10}script: \|\r?\n((?: {12}.*(?:\r?\n|$)|\r?\n)+)/m);
  assert.ok(match, 'GitHub script block must be present');
  const script = match[1]
    .split(/\r?\n/)
    .map((line) => line.slice(12))
    .join('\n');
  const writes = [];
  const github = {
    paginate: async () => comments,
    rest: {
      pulls: {
        get: async () => ({
          data: { head: { sha: head }, labels: labeled ? [{ name: 'ci:visuals' }] : [] },
        }),
      },
      issues: {
        listComments() {},
        updateComment: async (value) => writes.push({ kind: 'update', ...value }),
        createComment: async (value) => writes.push({ kind: 'create', ...value }),
      },
    },
  };
  const context = {
    repo: { owner: 'example', repo: 'example' },
    issue: { number: 1 },
    runId: 7,
    payload: { pull_request: { head: { sha: 'event-head' } } },
  };
  await new AsyncFunction('github', 'context', 'process', 'require', script)(
    github,
    context,
    { env: { HAS_FILES: 'false' } },
    require
  );
  return writes;
}

test('selected current-head preview is published with its commit', async () => {
  const writes = await runPreview('ci.yml');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'create');
  assert.match(writes[0].body, /Commit: `event-head`/);
});

test('a stale run cannot publish over the current head', async () => {
  assert.deepEqual(await runPreview('ci.yml', { head: 'new-head' }), []);
});

test('a removed visual label prevents late preview publishing', async () => {
  assert.deepEqual(await runPreview('ci.yml', { labeled: false }), []);
});

test('selected preview updates its existing bot comment', async () => {
  const writes = await runPreview('ci.yml', {
    comments: [{ id: 4, user: { type: 'Bot' }, body: marker }],
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'update');
  assert.equal(writes[0].comment_id, 4);
});

test('opt-out updates only the existing bot preview, using the current head', async () => {
  const writes = await runPreview('snapshot-preview-opt-out.yml', {
    labeled: false,
    head: 'new-head',
    comments: [
      { id: 4, user: { type: 'Bot' }, body: marker },
      { id: 5, user: { type: 'User' }, body: marker },
      { id: 6, user: { type: 'Bot' }, body: 'unrelated' },
    ],
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].comment_id, 4);
  assert.match(writes[0].body, /not selected for commit `new-head`/);
});

test('opt-out does not overwrite a preview after the label is re-added', async () => {
  assert.deepEqual(
    await runPreview('snapshot-preview-opt-out.yml', {
      comments: [{ id: 4, user: { type: 'Bot' }, body: marker }],
    }),
    []
  );
});

test('opt-out never creates a comment', async () => {
  assert.deepEqual(await runPreview('snapshot-preview-opt-out.yml', { labeled: false }), []);
});
