# Surreal Studios — phone / browser build

Static build of the Surreal Studios renderer with a browser bridge in place of the Electron preload.
It stores nothing of its own: everything reads and writes Surreal Cloud (Supabase, owner-only rows)
after you sign in. Built by `tools/build-web.py` in the main app repo.
