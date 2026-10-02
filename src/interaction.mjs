export function createInteractionStorage(api) {
  // Interaction availability is determined by the storage API, not block metadata.
  return {
    async readData() {
      try {
        const data = await api.Interaction.getData();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('Interaction 返回的数据格式无效，已停止统计写入。');
        }
        return data;
      } catch (cause) {
        if (!cause.message?.includes('API[Interaction.getData] call timeout')) throw cause;
        const error = new Error('Interaction 读取超时，未写入或重置统计数据。请刷新页面重试；若持续超时，检查调试服务的 useInteraction 配置和宿主请求错误。', { cause });
        error.code = 'INTERACTION_READ_TIMEOUT';
        throw error;
      }
    },
    async writeData(key, value) {
      return api.Interaction.setData({ type: 'replace', data: { path: [key], value } });
    },
  };
}
