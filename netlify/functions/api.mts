// Runs the O! Donut Club API as a Netlify Function. The app itself lives in server/src.
import { handleRequest } from '../../server/src/netlify.ts';

export default (req: Request) => handleRequest(req);

export const config = {
  path: ['/api/*', '/healthz'],
};
