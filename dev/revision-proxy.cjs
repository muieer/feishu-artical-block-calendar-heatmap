const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

function configuredDocument(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const token = config.revisionDocumentId || new URL(config.url).pathname.match(/^\/docx\/([a-zA-Z0-9]+)(?:\/|$)/)?.[1];
  if (!token || !/^[a-zA-Z0-9]+$/.test(token)) throw new Error('请在 app.json 中配置 docx 调试文档 url；Wiki 文档请额外填写 revisionDocumentId。');
  return token;
}

async function readDocumentRevision(token, executeCommand = execute) {
  let result;
  try {
    result = await executeCommand('lark-cli', ['api', 'GET', `/open-apis/docx/v1/documents/${token}`,
      '--as', 'user', '--format', 'json'], {
      timeout: 20000, maxBuffer: 1024 * 1024,
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    });
  } catch {
    throw new Error('无法通过 lark-cli 读取 revision。请在本机终端检查用户登录、文档读取权限及钥匙串访问。');
  }
  const envelope = JSON.parse(result.stdout);
  const revision = envelope.data?.document?.revision_id;
  if (envelope.ok !== true || !Number.isSafeInteger(revision) || revision < 0) throw new Error('飞书文档接口未返回有效 revision_id。');
  return revision;
}

function createRevisionMiddleware(configPath, readRevision = readDocumentRevision) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') { response.status(204).end(); return; }
    if (request.method !== 'GET') { response.status(405).json({ error: '仅支持 GET。' }); return; }
    try {
      const expected = configuredDocument(configPath);
      if (request.query.documentId !== expected) {
        response.status(403).json({ error: '当前文档与 app.json 中的调试文档不一致。' });
        return;
      }
      response.json({ revision_id: await readRevision(expected) });
    } catch (error) { response.status(503).json({ error: error.message }); }
  };
}

module.exports = { configuredDocument, readDocumentRevision, createRevisionMiddleware };
