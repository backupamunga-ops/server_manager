import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class UploadsService {
  /**
   * Initialize an upload — returns a presigned S3 URL for direct upload to Garage.
   * TODO: CL-050 will implement using @aws-sdk/client-s3 against Garage endpoint.
   */
  async init(filename: string, size: number, mimeType: string): Promise<{ uploadId: string; uploadUrl: string; expiresAt: string }> {
    throw new NotImplementedException({
      code: 'NOT_IMPLEMENTED',
      message: 'Upload init is implemented in CL-050. Set up Garage S3 first.',
    });
  }

  async finalize(uploadId: string, sha256: string): Promise<{ uploadId: string; validated: true; detectedFramework: string; entryCount: number }> {
    throw new NotImplementedException({
      code: 'NOT_IMPLEMENTED',
      message: 'Upload finalize is implemented in CL-050.',
    });
  }
}
