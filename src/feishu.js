import { BlockitClient, DocMiniApp } from '@lark-opdev/block-docs-addon-api';
import { revisionNumber } from './activity.mjs';
import { createInteractionStorage } from './interaction.mjs';

export async function connectFeishu() {
  const client = new BlockitClient();
  // BlockitClient 0.0.11 initializes the API in its constructor.
  const api = DocMiniApp;
  const doc = await api.getActiveDocumentRef();
  return {
    ...createInteractionStorage(api),
    async readRevision() {
      if (!REVISION_API_URL) throw new Error('当前程序包未配置 revision API。开发验证请使用 npm start 的飞书调试入口。');
      const url = new URL(REVISION_API_URL, window.location.href);
      url.searchParams.set('documentId', doc.docToken);
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(25000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'revision 读取失败。');
      return revisionNumber(result.revision_id);
    },
    resize: () => api.Bridge.updateHeight(),
    async listen(handler) {
      await api.Events.onDocumentChange(doc, handler);
      return () => api.Events.offDocumentChange(doc, handler);
    },
    destroy: () => client.destroy(),
  };
}
