// Runs the O! Donut Club API as a Netlify Function. The app itself lives in server/src.
import { handleRequest } from '../../server/dist-netlify/netlify.mjs';

export default (req: Request) => handleRequest(req);

export const config = {
  path: ['/api/*', '/healthz'],
};
