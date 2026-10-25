# Hook Cutter

Finds the strongest hook moments in a long video from its audio, lets you preview and trim each one, and exports it as a 9:16 vertical clip with an optional credit line.

Everything runs in your browser. The video is never uploaded.

## Use it (file upload, no install)

Open `index.html` in Chrome, Edge or Firefox, or use the GitHub Pages site, and choose a video file.

## Use it with a YouTube link (local only)

    python3 -m venv venv
    source venv/bin/activate
    pip install -U "yt-dlp[default]"
    sudo apt install -y ffmpeg
    python3 server.py

Then open http://localhost:8000 and paste a link. GitHub Pages cannot run `server.py`, so the link box only appears when you run it locally.

## Note

Only clip videos that are yours or that you have permission to use. Giving credit does not give you permission.
