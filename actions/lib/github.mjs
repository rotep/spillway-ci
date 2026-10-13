// A minimal GitHub REST client shared by the actions and by discovery.
// No dependencies: Node's global fetch only, so the actions run without an
// install step and the supply chain stays at zero third-party packages.

const API_VERSION = '2022-11-28';
const MAX_PAGES = 50;

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function createClient({ token, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, userAgent = 'spillway' }) {
  if (!token) throw new Error('A GitHub token is required.');

  async function request(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': API_VERSION,
        'user-agent': userAgent,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new GitHubError(`${method} ${path}: HTTP ${res.status}${data?.message ? ` ${data.message}` : ''}`, res.status);
    }
    return data;
  }

  // Follows page numbers until a short page. `key` names the array inside the
  // response object for endpoints that wrap their items (jobs, repositories).
  async function paginate(path, key) {
    const items = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      const batch = key ? data[key] : data;
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new Error(`${path}: more than ${MAX_PAGES} pages; refusing to continue.`);
  }

  return { request, paginate };
}
