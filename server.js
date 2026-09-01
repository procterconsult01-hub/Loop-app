const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const useR2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET_NAME);

let s3 = null;
if (useR2) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  console.log('Media storage: Cloudflare R2 (uploads survive redeploys)');
} else {
  console.log('Media storage: local disk (uploads will NOT survive a redeploy — set R2_* env vars to fix this)');
}

const localUploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(localUploadsDir)) fs.mkdirSync(localUploadsDir, { recursive: true });

// Takes a multer file object (buffer in memory) and returns a public URL.
async function saveFile(file) {
  const key = `${uuid()}${path.extname(file.originalname)}`;

  if (useR2) {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype
    }));
    // R2_PUBLIC_URL is the bucket's public r2.dev URL or a custom domain you attached to it.
    const base = process.env.R2_PUBLIC_URL;
    if (!base) throw new Error('R2 is configured but R2_PUBLIC_URL is not set — see README for how to get it');
    return `${base.replace(/\/$/, '')}/${key}`;
  } else {
    fs.writeFileSync(path.join(localUploadsDir, key), file.buffer);
    return `/uploads/${key}`;
  }
}

module.exports = { saveFile, useR2, localUploadsDir };
