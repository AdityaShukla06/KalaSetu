export interface BackgroundRemovalService {
  removeBackground(input: Buffer, mimeType: string): Promise<Buffer>;
}
