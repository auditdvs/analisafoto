import type { OwnCloudFile } from './types';

const BASE_URL = process.env.OWNCLOUD_BASE_URL!;
const USERNAME = process.env.OWNCLOUD_USERNAME!;
const PASSWORD = process.env.OWNCLOUD_PASSWORD!;

const WEBDAV_BASE = `${BASE_URL}/remote.php/webdav`;

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
}

/**
 * Parse WebDAV PROPFIND XML response into OwnCloudFile[]
 */
export function parseWebDAVResponse(xml: string, requestedPath: string): OwnCloudFile[] {
  const files: OwnCloudFile[] = [];

  // Match each <d:response> block
  const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
  let match;

  while ((match = responseRegex.exec(xml)) !== null) {
    const block = match[1];

    const href = (block.match(/<d:href>(.*?)<\/d:href>/) || [])[1] || '';
    const displayName = (block.match(/<d:displayname>(.*?)<\/d:displayname>/) || [])[1] || '';
    const contentLength = (block.match(/<d:getcontentlength>(.*?)<\/d:getcontentlength>/) || [])[1] || '0';
    const contentType = (block.match(/<d:getcontenttype>(.*?)<\/d:getcontenttype>/) || [])[1] || '';
    const lastModified = (block.match(/<d:getlastmodified>(.*?)<\/d:getlastmodified>/) || [])[1] || '';
    const etag = (block.match(/<d:getetag>(.*?)<\/d:getetag>/) || [])[1] || '';
    const isDirectory = block.includes('<d:collection/>');

    // Decode href
    const decodedHref = decodeURIComponent(href);

    // Skip the parent directory itself (the requested path)
    const cleanRequestedPath = requestedPath.replace(/\/$/, '');
    if (decodedHref.replace(/\/$/, '').endsWith(cleanRequestedPath) && decodedHref !== href) continue;
    
    // Extract file name from href
    const hrefParts = decodedHref.replace(/\/$/, '').split('/');
    const name = displayName || hrefParts[hrefParts.length - 1] || '';

    // Skip parent itself
    if (!name) continue;

    // Build a stable ID from etag or href
    const id = etag.replace(/['"]/g, '') || Buffer.from(decodedHref).toString('base64');

    // Reconstruct the path relative to /remote.php/webdav
    const webdavPrefix = '/remote.php/webdav';
    const filePath = decodedHref.includes(webdavPrefix)
      ? decodedHref.substring(decodedHref.indexOf(webdavPrefix) + webdavPrefix.length)
      : decodedHref;

    files.push({
      id,
      name,
      path: filePath,
      size: parseInt(contentLength, 10),
      mimeType: isDirectory
        ? 'application/x-directory'
        : (contentType || 'application/octet-stream'),
      modifiedAt: lastModified ? new Date(lastModified).toISOString() : '',
      type: isDirectory ? 'directory' : 'file',
      href: decodedHref,
    });
  }

  return files;
}

/**
 * List files in a specific path on ownCloud
 */
export async function listFiles(path: string): Promise<OwnCloudFile[]> {
  const url = `${WEBDAV_BASE}${path}`;

  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(),
      Depth: '1',
      'Content-Type': 'application/xml',
    },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:getetag/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
  });

  if (!response.ok) {
    throw new Error(`ownCloud PROPFIND failed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const all = parseWebDAVResponse(xml, path);

  // Filter out parent directory entry
  return all.filter(f => f.path !== path && f.path !== path + '/');
}

/**
 * Get a single file's metadata by path
 */
export async function getFile(path: string): Promise<OwnCloudFile> {
  const url = `${WEBDAV_BASE}${path}`;

  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(),
      Depth: '0',
      'Content-Type': 'application/xml',
    },
    body: `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:getetag/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
  });

  if (!response.ok) {
    throw new Error(`ownCloud PROPFIND failed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();
  const files = parseWebDAVResponse(xml, path);

  if (files.length === 0) {
    throw new Error(`File not found: ${path}`);
  }

  return files[0];
}

/**
 * Stream a file from ownCloud — returns the raw fetch Response
 * Caller is responsible for piping the body.
 */
export async function downloadFileStream(path: string): Promise<Response> {
  const url = `${WEBDAV_BASE}${path}`;

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader(),
    },
  });

  if (!response.ok) {
    throw new Error(`ownCloud download failed: ${response.status} ${response.statusText}`);
  }

  return response;
}
