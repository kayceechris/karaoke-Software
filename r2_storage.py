"""Cloudflare R2 (S3-compatible) object storage client.

Used only by agent.py to mirror local song files so the cloud-hosted
/tablet (cloud_app.py, which never touches these credentials) can redirect
guests straight to a public R2 URL instead of relaying video through Render.

All env vars are optional — when unset, ENABLED is False and agent.py skips
media sync entirely (LAN-only behavior, unchanged from before this existed).
"""

import mimetypes
import os
from urllib.parse import quote

import boto3
import requests

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
R2_PUBLIC_BASE_URL = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")

ENABLED = bool(R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
               and R2_BUCKET and R2_PUBLIC_BASE_URL)

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name="auto",
        )
    return _client


def public_url(key):
    return f"{R2_PUBLIC_BASE_URL}/{quote(key, safe='/')}"


def object_exists(key):
    """Cheap existence check against the bucket's public URL — no S3 auth needed
    since the bucket has public read access."""
    try:
        r = requests.head(public_url(key), timeout=10)
        return r.status_code == 200
    except requests.RequestException:
        return False


def upload_file(key, local_path):
    """Upload local_path to R2 under key, guessing content-type from the extension."""
    content_type = mimetypes.guess_type(local_path)[0] or "application/octet-stream"
    _get_client().upload_file(
        local_path, R2_BUCKET, key,
        ExtraArgs={"ContentType": content_type},
    )
