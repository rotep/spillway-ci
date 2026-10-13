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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `retries` repeats a request that failed in the network ("fetch failed") or
// with a 5xx, after 2, 4, 8 … seconds. A 4xx is an answer and is not repeated.
export function createClient({ token, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch, userAgent = 'spillway', retries = 0, sleep = delay }) {
  if (!token) throw new Error('A GitHub token is required.');

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(method, path, body);
      } catch (error) {
        const transient = error instanceof TypeError || (error instanceof GitHubError && error.status >= 500);
        if (!transient || attempt >= retries) throw error;
        console.log(`${method} ${path}: ${error.message}; retrying (${attempt + 1}/${retries}).`);
        await sleep(2000 * 2 ** attempt);
      }
    }
  }

  async function requestOnce(method, path, body) {
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
    if (!res.ok) {
      // A 5xx from a proxy or GitHub's edge may be an HTML page.
      let message;
      try { message = JSON.parse(text)?.message; } catch { message = undefined; }
      throw new GitHubError(`${method} ${path}: HTTP ${res.status}${message ? ` ${message}` : ''}`, res.status);
    }
    return text ? JSON.parse(text) : null;
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

// The commit a branch (or, failing that, a tag) points at now, or undefined
// when neither exists. Needs only `contents: read`.
export async function refHead({ client, repo, name }) {
  const encoded = name.split('/').map(encodeURIComponent).join('/');
  for (const kind of ['heads', 'tags']) {
    try {
      const ref = await client.request('GET', `/repos/${repo.owner}/${repo.name}/git/ref/${kind}/${encoded}`);
      return { kind, sha: ref?.object?.sha };
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
  }
  return undefined;
}
