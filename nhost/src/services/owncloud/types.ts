export interface OwnCloudFile {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
  modifiedAt: string;
  type: 'file' | 'directory';
  href: string;
}
