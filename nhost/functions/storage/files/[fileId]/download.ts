import type { Request, Response } from 'express';
import { listFiles, downloadFileStream } from '../../../../src/services/owncloud/client';

const ALLOWED_PATH = '/DIVISI INTERNAL AUDIT/DVS/Analisa Foto Pencairan';

function isAuthorized(req: Request): boolean {
  const token = process.env.STORAGE_SERVICE_TOKEN;
  if (!token) return true;
  const authHeader = req.headers['authorization'] || '';
  return authHeader === `Bearer ${token}`;
}

export default async function handler(req: Request, res: Response) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  // fileId di sini adalah path yang di-encode Base64 atau nama file
  const { fileId } = req.params as { fileId: string };

  if (!fileId) {
    return res.status(400).json({ error: 'fileId is required' });
  }

  try {
    // Temukan file dengan cara list folder dan cari berdasarkan id
    const files = await listFiles(ALLOWED_PATH);
    const file = files.find(f => f.id === fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Path traversal protection — pastikan file.path ada dalam folder yang diizinkan
    if (!file.path.startsWith(ALLOWED_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Stream file dari ownCloud langsung ke response
    const ownCloudResponse = await downloadFileStream(file.path);

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');

    if (file.size > 0) {
      res.setHeader('Content-Length', file.size.toString());
    }

    // Pipe response body langsung tanpa buffering seluruh file ke memory
    if (ownCloudResponse.body) {
      const reader = ownCloudResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      // Fallback jika ReadableStream tidak tersedia
      const buffer = await ownCloudResponse.arrayBuffer();
      res.end(Buffer.from(buffer));
    }

  } catch (err: any) {
    console.error('[storage/download] Error:', err.message);
    return res.status(502).json({ error: 'Failed to download file from ownCloud' });
  }
}
