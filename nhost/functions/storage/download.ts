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
  const authHeader = req.headers['authorization'] || '';
  const queryToken = req.query.token as string;
  return authHeader === `Bearer ${token}` || queryToken === token;
}

// ——— WebDAV PROPFIND parser ——————————————————————————
function parseWebDAV(xml: string) {
  const files: any[] = [];
  const re = /<d:response>([\s\S]*?)<\/d:response>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const href     = decodeURIComponent((b.match(/<d:href>(.*?)<\/d:href>/)               || [])[1] || '');
    const name     = (b.match(/<d:displayname>(.*?)<\/d:displayname>/)                    || [])[1] || '';
    const size     = parseInt((b.match(/<d:getcontentlength>(.*?)<\/d:getcontentlength>/) || [])[1] || '0', 10);
    const mime     = (b.match(/<d:getcontenttype>(.*?)<\/d:getcontenttype>/)              || [])[1] || '';
    const modified = (b.match(/<d:getlastmodified>(.*?)<\/d:getlastmodified>/)            || [])[1] || '';
    const etag     = ((b.match(/<d:getetag>(.*?)<\/d:getetag>/)                           || [])[1] || '').replace(/['"]/g, '');
    const isDir    = b.includes('<d:collection/>');
    const prefix   = '/remote.php/webdav';
    const path     = href.includes(prefix)
      ? href.substring(href.indexOf(prefix) + prefix.length)
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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type, Content-Range');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { fileId } = req.query as { fileId?: string };
  if (!fileId) return res.status(400).json({ error: 'fileId query parameter is required' });

  try {
    // List semua file untuk mencari berdasarkan id
    const listUrl = `${WEBDAV_BASE}${ALLOWED_PATH}`;
    const listResp = await (fetch as any)(listUrl, {
      method: 'PROPFIND',
      headers: { Authorization: authHeader(), Depth: '1', 'Content-Type': 'application/xml' },
      body: PROPFIND_BODY,
      agent,
    });

    if (!listResp.ok) throw new Error(`PROPFIND ${listResp.status}`);

    const xml = await listResp.text();
    const all = parseWebDAV(xml);
    const file = all.find((f: any) => f.id === fileId);

    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!file.path.startsWith(ALLOWED_PATH)) return res.status(403).json({ error: 'Access denied' });

    // Ambil header Range dari frontend (jika ada)
    const range = req.headers['range'] as string | undefined;
    const fetchHeaders: any = { Authorization: authHeader() };
    if (range) fetchHeaders['Range'] = range;

    const dlResp = await (fetch as any)(`${WEBDAV_BASE}${file.path}`, {
      headers: fetchHeaders,
      agent,
    });

    if (!dlResp.ok && dlResp.status !== 206) {
      throw new Error(`Download HTTP ${dlResp.status}`);
    }

    const arrayBuffer = await dlResp.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));

    // Jika ownCloud mengembalikan chunk (206 Partial Content), kita teruskan
    if (dlResp.headers.get('content-range')) {
      res.setHeader('Content-Range', dlResp.headers.get('content-range')!);
      return res.status(206).end(buffer);
    }

    return res.end(buffer);

  } catch (err: any) {
    console.error('[storage/download]', err.message);
    return res.status(502).json({ error: `Gagal memproses download: ${err.message}` });
  }
}
