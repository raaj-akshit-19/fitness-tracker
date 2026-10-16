"""The web edition, as gunicorn serves it in production (see render.yaml):

    gunicorn wsgi:app --bind 0.0.0.0:$PORT

Settings come from the environment (SUPABASE_URL, SUPABASE_ANON_KEY; see
.env.example). Missing settings stop it at start, with a message saying which.
"""

import logging

from backend.app import create_app

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = create_app()
