import { BlockitClient, DocMiniApp } from '@lark-opdev/block-docs-addon-api';
import { createInteractionStorage } from './interaction.mjs';

export async function connectFeishu() {
  const client = new BlockitClient();
  // BlockitClient 0.0.11 initializes the API in its constructor.
  const api = DocMiniApp;
  const doc = await api.getActiveDocumentRef();
  return {
    ...createInteractionStorage(api),
    resize: () => api.Bridge.updateHeight(),
    async listen(handler) {
      await api.Events.onDocumentChange(doc, handler);
      return () => api.Events.offDocumentChange(doc, handler);
    },
    destroy: () => client.destroy(),
  };
}
