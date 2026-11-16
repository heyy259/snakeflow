import { createSeApiMiddleware, attachSeWebSocket } from '../se/api.js';
import { createGraphsApiMiddleware } from '../graphsApi.js';

export function createApiRouter(options = {}) {
  const se = createSeApiMiddleware(options);
  const graphs = createGraphsApiMiddleware(options);
  return async (req, res, next) => se(req, res, () => graphs(req, res, next));
}

export { attachSeWebSocket };
