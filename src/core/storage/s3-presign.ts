import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { httpEndpointProblem, normalizeHttpEndpoint, SIGNED_URL_EXPIRES_DEFAULT } from '../storage-url.ts';

export interface PresignS3GetOptions {
  bucket: string;
  key: string;
  region: string;
  /** Custom S3 endpoint. Path-style (`/<bucket>/<key>`). Omit for virtual-hosted AWS. */
  endpoint?: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  expiresIn?: number;
  /** Frozen signing time for tests. Production callers omit it. */
  now?: Date;
}

/**
 * Time-limited SigV4 GET for a private object. Checksums stay off unless the
 * caller asked for one: a default checksum query makes MinIO and other
 * S3-compatible stores reject a browser GET. The key is passed raw; the signer
 * percent-encodes each path segment and leaves `/` as the separator.
 */
export async function presignS3Get(opts: PresignS3GetOptions): Promise<string> {
  const endpoint = opts.endpoint && !httpEndpointProblem(opts.endpoint) ? normalizeHttpEndpoint(opts.endpoint) : opts.endpoint;
  const client = new S3Client({
    region: opts.region || 'us-east-1',
    credentials: opts.credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  try {
    return await getSignedUrl(client, new GetObjectCommand({ Bucket: opts.bucket, Key: opts.key }), {
      expiresIn: opts.expiresIn ?? SIGNED_URL_EXPIRES_DEFAULT,
      ...(opts.now ? { signingDate: opts.now } : {}),
    });
  } finally {
    client.destroy();
  }
}
