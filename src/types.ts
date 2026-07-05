export interface Photo {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  theme: string;
  tags: string[];
  description: string;
  uploadedAt: string;
  userId?: string;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  createdAt: string;
}

