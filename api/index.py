# Vercel serverless entry point. Vercel's @vercel/python looks for `app`.
# NOTE: Vercel has no database — you MUST set DATABASE_URL (e.g. a free Neon or
# Supabase Postgres) and HOST_TOKEN in the Vercel project's Environment settings.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cloud_app import app  # noqa: E402,F401
