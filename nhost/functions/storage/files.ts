import type { Request, Response } from 'express';
import { listFiles } from '../../src/services/owncloud/client';

// Path di ownCloud yang akan di-expose
const ALLOWED_PATH = '/DIVISI INTERNAL AUDIT/DVS/Analisa Foto Pencairan';

// Simple token auth — token disimpan di Nhost Secret: STORAGE_SERVICE_TOKEN
function isAuthorized(req: Request): boolean {
  const token = process.env.STORAGE_SERVICE_TOKEN;
  if (!token) return true; // jika secret belum diset, bypass dulu (dev mode)

  const authHeader = req.headers['authorization'] || '';
  return authHeader === `Bearer ${token}`;
}

export default async function handler(req: Request, res: Response) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const files = await listFiles(ALLOWED_PATH);

    // Hanya tampilkan file (bukan direktori) untuk keamanan
    const fileOnly = files.filter(f => f.type === 'file');

    return res.status(200).json({
      data: fileOnly.map(f => ({
        id: f.id,
        name: f.name,
        path: f.path,
        size: f.size,
        mimeType: f.mimeType,
        modifiedAt: f.modifiedAt,
        type: f.type,
      })),
    });
  } catch (err: any) {
    console.error('[storage/files] Error:', err.message);
    return res.status(502).json({ error: 'Failed to fetch file list from ownCloud' });
  }
}
