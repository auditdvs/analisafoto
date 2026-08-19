import type { Request, Response } from 'express';
import https from 'https';

// ——— Config ———————————————————————————————————————————
const BASE_URL = process.env.OWNCLOUD_BASE_URL ?? 'https://cloud.komida.co.id';
const USERNAME = process.env.OWNCLOUD_USERNAME ?? '';
const PASSWORD = process.env.OWNCLOUD_PASSWORD ?? '';
const WEBDAV_BASE = `${BASE_URL}/remote.php/webdav`;
const ALLOWED_PATH = '/DIVISI INTERNAL AUDIT/DVS/Analisa Foto Pencairan';

const agent = new https.Agent({ rejectUnauthorized: false });

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
}

function isAuthorized(req: Request): boolean {
  const token = process.env.STORAGE_SERVICE_TOKEN;
  if (!token) return true;
  return req.headers['authorization'] === `Bearer ${token}`;
}

// ——— WebDAV PROPFIND parser ——————————————————————————
function parseWebDAV(xml: string) {
  const files: any[] = [];
  const re = /<d:response>([\s\S]*?)<\/d:response>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const href       = decodeURIComponent((b.match(/<d:href>(.*?)<\/d:href>/)             || [])[1] || '');
    const name       = (b.match(/<d:displayname>(.*?)<\/d:displayname>/)                  || [])[1] || '';
    const size       = parseInt((b.match(/<d:getcontentlength>(.*?)<\/d:getcontentlength>/) || [])[1] || '0', 10);
    const mime       = (b.match(/<d:getcontenttype>(.*?)<\/d:getcontenttype>/)            || [])[1] || '';
    const modified   = (b.match(/<d:getlastmodified>(.*?)<\/d:getlastmodified>/)          || [])[1] || '';
    const etag       = ((b.match(/<d:getetag>(.*?)<\/d:getetag>/)                         || [])[1] || '').replace(/['"]/g, '');
    const isDir      = b.includes('<d:collection/>');
    const webdavPrefix = '/remote.php/webdav';
    const path = href.includes(webdavPrefix)
      ? href.substring(href.indexOf(webdavPrefix) + webdavPrefix.length)
      : href;
    const finalName = name || href.replace(/\/$/, '').split('/').pop() || '';
    if (!finalName) continue;
    files.push({
      id: etag || Buffer.from(href).toString('base64'),
      name: finalName,
      path,
      size,
      mimeType: isDir ? 'application/x-directory' : (mime || 'application/octet-stream'),
      modifiedAt: modified ? new Date(modified).toISOString() : '',
      type: isDir ? 'directory' : 'file',
    });
  }
  return files;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/><d:getcontentlength/><d:getcontenttype/>
    <d:getlastmodified/><d:getetag/><d:resourcetype/>
  </d:prop>
</d:propfind>`;

// ——— Handler ——————————————————————————————————————————
export default async function handler(req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const url = `${WEBDAV_BASE}${ALLOWED_PATH}`;
    const resp = await (fetch as any)(url, {
      method: 'PROPFIND',
      headers: { Authorization: authHeader(), Depth: '1', 'Content-Type': 'application/xml' },
      body: PROPFIND_BODY,
      agent,
    });

    if (!resp.ok) throw new Error(`PROPFIND ${resp.status}`);

    const xml = await resp.text();
    const all = parseWebDAV(xml);
    const fileOnly = all.filter((f: any) =>
      f.type === 'file' &&
      f.path !== ALLOWED_PATH &&
      f.path !== ALLOWED_PATH + '/'
    );

    return res.status(200).json({ data: fileOnly });
  } catch (err: any) {
    console.error('[storage/files]', err.message);
    return res.status(502).json({ error: `Failed to fetch file list from ownCloud: ${err.message}` });
  }
}
