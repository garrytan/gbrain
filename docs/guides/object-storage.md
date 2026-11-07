# Private object storage (S3, MinIO, R2)

PDFs, images, audio, and video live in object storage. `gbrain files signed-url` and the `file_url` operation return a **time-limited presigned GET**. The bucket stays private: this path does not change a bucket ACL or grant public-read.

**Say to your agent:** *"Give me a one-hour link to open the stored file."* — *"Sign a download link for this attachment."* The agent runs `gbrain files signed-url <storage-path>` (or calls `file_url` with that `storage_path`). The link expires. The default is one hour. `storage.signedUrlExpiresIn` sets the lifetime in seconds, up to 7 days (`604800`).

Supabase Storage already returns its own signed URL. The settings below apply to the S3-compatible backend (AWS S3, Cloudflare R2, MinIO).

## MinIO on the same machine as the brain

`storage.endpoint` is the address gbrain uses to upload, download, and check objects. On a single host that is often loopback:

```json
"endpoint": "http://127.0.0.1:9000"
```

A presigned URL signed for that host points at the brain machine's loopback interface. A phone, another computer, or a cloud agent cannot open it. Signing the URL does not change that.

Set `storage.publicEndpoint` to the http(s) origin those clients already use to reach the **same** MinIO. gbrain signs the GET for that host. Uploads, downloads, and existence checks keep using `storage.endpoint`.

```json
"storage": {
  "backend": "s3",
  "bucket": "brain-files",
  "region": "us-east-1",
  "endpoint": "http://127.0.0.1:9000",
  "publicEndpoint": "https://files.example.ts.net",
  "accessKeyId": "YOUR_ACCESS_KEY",
  "secretAccessKey": "YOUR_SECRET",
  "signedUrlExpiresIn": 3600
}
```

The same leaves can be set on the file that holds this object (`~/.gbrain/config.json`):

```bash
gbrain config set storage.publicEndpoint https://files.example.ts.net
gbrain config set storage.signedUrlExpiresIn 3600
```

`publicEndpoint` is an `http` or `https` origin plus an optional path prefix, the same shape as `endpoint`. It has no username, password, query, or fragment. The signed path is `<publicEndpoint>/<bucket>/<key>`, so the value is the service root (for example `https://files.example.ts.net` or `https://files.example.ts.net/s3`).

The proxy or tailnet listener in front of MinIO has to present that host to MinIO. When a proxy rewrites `Host` to `127.0.0.1`, MinIO rejects the signature. Publishing the MinIO port on the tailnet, with the public host preserved, is the usual layout. `gbrain serve --public-url` sets the brain's HTTP address. Object URLs use `storage.publicEndpoint`.

Object keys are percent-encoded per path segment, including non-ASCII names. `/` stays the separator between segments.

When the signed host is still loopback, gbrain writes a notice to stderr. The notice does not include the URL, so logs do not keep the signature. Set `publicEndpoint`, then ask for the link again.

Leave the bucket private. A public-read ACL is not required and this feature does not set one.
