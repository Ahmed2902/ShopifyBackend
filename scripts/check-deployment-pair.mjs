import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';

// Pure validation: never requests a URL or reports environment values.
export function checkDeploymentPair(backend, frontend) {
  const failures = [];
  const value = (input, key) => input[key]?.trim() ?? '';
  const origin = (input, key) => {
    try {
      const url = new URL(value(input, key));
      const reserved = /(^|\.)(localhost|example\.(com|org|net))$|\.(test|invalid|localhost)$/i;
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        reserved.test(url.hostname) ||
        /^[\d.]+$/.test(url.hostname) ||
        url.hostname.includes(':') ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error();
      return url.origin;
    } catch {
      failures.push(
        `${key} must be a public HTTPS origin without credentials, a path, query or fragment`,
      );
      return null;
    }
  };
  const api = origin(backend, 'APP_URL');
  const site = origin(backend, 'FRONTEND_URL');
  const publicApi = origin(frontend, 'NEXT_PUBLIC_API_URL');
  const publicSite = origin(frontend, 'NEXT_PUBLIC_SITE_URL');
  const publicApp = value(frontend, 'NEXT_PUBLIC_APP_URL')
    ? origin(frontend, 'NEXT_PUBLIC_APP_URL')
    : publicSite;
  if (api && publicApi && api !== publicApi)
    failures.push('NEXT_PUBLIC_API_URL must match APP_URL');
  if (site && publicApp && site !== publicApp)
    failures.push(
      'NEXT_PUBLIC_APP_URL (or NEXT_PUBLIC_SITE_URL when omitted) must match FRONTEND_URL',
    );
  if (
    api &&
    value(backend, 'TIKTOK_REDIRECT_URI') &&
    value(backend, 'TIKTOK_REDIRECT_URI') !==
      new URL('/v1/integrations/tiktok/callback', api).toString()
  ) {
    failures.push(
      'TIKTOK_REDIRECT_URI must match APP_URL plus /v1/integrations/tiktok/callback; register that exact URL in TikTok API for Business',
    );
  }
  if (
    !value(backend, 'SHOPIFY_CLIENT_ID') ||
    value(backend, 'SHOPIFY_CLIENT_ID') !== value(frontend, 'NEXT_PUBLIC_SHOPIFY_API_KEY')
  ) {
    failures.push('NEXT_PUBLIC_SHOPIFY_API_KEY must match the nonempty SHOPIFY_CLIENT_ID');
  }
  if (value(backend, 'CORS_ORIGIN')) {
    const cors = origin(backend, 'CORS_ORIGIN');
    if (site && cors && cors !== site) failures.push('CORS_ORIGIN must match FRONTEND_URL');
  }
  for (const [key, expectedOrigin, expectedPath] of [
    ['SHOPIFY_APP_URL', site, null],
    ['SHOPIFY_REDIRECT_URI', site, '/api/shopify/callback'],
    ['PIXEL_COLLECTOR_URL', api, '/v1/pixel/events'],
  ]) {
    if (key === 'PIXEL_COLLECTOR_URL' && !value(backend, key)) continue;
    try {
      const url = new URL(value(backend, key));
      if (
        !expectedOrigin ||
        url.origin !== expectedOrigin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (expectedPath ? url.pathname !== expectedPath : !/^\/app(?:\/|$)/.test(url.pathname))
      )
        throw new Error();
    } catch {
      failures.push(`${key} must use the configured origin and expected application route`);
    }
  }
  const support = value(backend, 'SHOPIFY_SUPPORT_EMAIL');
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support) ||
    /@(example\.(com|org|net)|.+\.(test|invalid))$/i.test(support) ||
    support.toLowerCase() !== value(frontend, 'NEXT_PUBLIC_SUPPORT_EMAIL').toLowerCase()
  ) {
    failures.push(
      'NEXT_PUBLIC_SUPPORT_EMAIL must match the configured public SHOPIFY_SUPPORT_EMAIL',
    );
  }
  for (const key of Object.keys(frontend)) {
    if (
      key.startsWith('NEXT_PUBLIC_') &&
      /(SECRET|TOKEN|PASSWORD|ENCRYPTION|PRIVATE_KEY|DATABASE|REDIS)/i.test(key) &&
      value(frontend, key)
    ) {
      failures.push(
        'A secret-like NEXT_PUBLIC setting must be removed from the frontend environment',
      );
    }
  }
  return [...new Set(failures)];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--backend-env' || args[2] !== '--frontend-env') {
    console.error(
      'Usage: npm run release:check-config -- --backend-env /path/backend.env --frontend-env /path/frontend.env',
    );
    process.exitCode = 1;
    return;
  }
  let failures;
  try {
    const backend = parse(await readFile(args[1], 'utf8'));
    const frontend = parse(await readFile(args[3], 'utf8'));
    failures = checkDeploymentPair(backend, frontend);
  } catch {
    console.error(
      'FAIL: Could not read both environment files. No configuration values were printed.',
    );
    process.exitCode = 1;
    return;
  }
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length) process.exitCode = 1;
  else
    console.log(
      'PASS: Deployment settings agree. This does not verify DNS, TLS, mailbox monitoring, Shopify approval or a live installation.',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
