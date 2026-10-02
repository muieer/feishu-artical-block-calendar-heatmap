const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configuredDocument, readDocumentRevision, createRevisionMiddleware } = require('../dev/revision-proxy.cjs');

test('OpenAPI CLI 响应按 ok 解析，只返回文档 revision，显式使用 user 身份', async () => {
  const revision = await readDocumentRevision('doc123', async (command, args) => {
    assert.equal(command, 'lark-cli');
    assert.deepEqual(args, ['api', 'GET', '/open-apis/docx/v1/documents/doc123', '--as', 'user', '--format', 'json']);
    return { stdout: JSON.stringify({ ok: true, data: { document: { revision_id: 123, title: 'private' } } }) };
  });
  assert.equal(revision, 123);
  await assert.rejects(readDocumentRevision('doc123', async () => ({ stdout: '{"ok":false}' })), /有效/);
  await assert.rejects(readDocumentRevision('doc123', async () => { throw new Error('private credential'); }), error => !error.message.includes('private credential'));
});

test('代理只允许配置中的调试文档；OPTIONS 不读取 revision', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap-test-'));
  try {
    const config = path.join(directory, 'app.json');
    fs.writeFileSync(config, JSON.stringify({ url: 'https://example.feishu.cn/docx/doc123' }));
    assert.equal(configuredDocument(config), 'doc123');
    let reads = 0;
    const middleware = createRevisionMiddleware(config, async () => { reads++; return 111; });
    const response = () => ({ code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; }, end() {} });
    const rejected = response();
    await middleware({ method: 'GET', query: { documentId: 'otherDoc' } }, rejected);
    assert.equal(rejected.code, 403);
    assert.equal(reads, 0);
    const allowed = response();
    await middleware({ method: 'GET', query: { documentId: 'doc123' } }, allowed);
    assert.deepEqual(allowed.body, { revision_id: 111 });
    assert.equal(allowed.headers['Cache-Control'], 'no-store');
    const options = response();
    await middleware({ method: 'OPTIONS' }, options);
    assert.equal(options.code, 204);
    assert.equal(reads, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
