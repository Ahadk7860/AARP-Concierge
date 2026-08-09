// S3-compatible object storage client (Cloudflare R2).
//
// At <10k users: a single bucket. At >10k: shard by user_id prefix.
// The S3 API is deliberately narrow — only the operations R2 needs.

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type R2Config = {
  endpoint: string;       // https://{account}.r2.cloudflarestorage.com
  region: string;         // 'auto'
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

function client(config: R2Config): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export function createR2Store(config: R2Config) {
  const s3 = client(config);

  return {
    async put(key: string, body: Buffer | string, contentType: string = "application/octet-stream"): Promise<void> {
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }));
    },

    async get(key: string): Promise<Buffer | null> {
      try {
        const res = await s3.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }));
        return Buffer.from(await res.Body!.transformToByteArray());
      } catch (e: unknown) {
        if ((e as { name?: string }).name === "NoSuchKey") return null;
        throw e;
      }
    },

    async delete(key: string): Promise<void> {
      await s3.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }));
    },

    async deletePrefix(prefix: string): Promise<number> {
      let count = 0;
      let token: string | undefined;
      do {
        const res = await s3.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }));
        const keys = (res.Contents ?? []).map(c => ({ Key: c.Key! }));
        if (keys.length > 0) {
          // S3 doesn't have batch delete in @aws-sdk v3 ListObjects — delete one at a time
          for (const k of keys) {
            await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: k.Key! }));
            count++;
          }
        }
        token = res.NextContinuationToken;
      } while (token);
      return count;
    },

    async prefixExists(prefix: string): Promise<boolean> {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        MaxKeys: 1,
      }));
      return (res.Contents?.length ?? 0) > 0;
    },

    async head(key: string): Promise<{ contentLength?: number; contentType?: string } | null> {
      try {
        const res = await s3.send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }));
        return { contentLength: res.ContentLength, contentType: res.ContentType };
      } catch (e: unknown) {
        if ((e as { name?: string }).name === "NotFound") return null;
        throw e;
      }
    },

    presignedUploadUrl(key: string, expiresInSeconds: number = 3600): Promise<string> {
      return getSignedUrl(s3, new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }), { expiresIn: expiresInSeconds });
    },
  };
}

export type R2Store = ReturnType<typeof createR2Store>;
