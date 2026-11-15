# Render PeerJS + TURN configuration service

Use `Root Directory: server`, `Build Command: npm install`, and `Start Command: npm start` in Render.

Set Render Environment variables `METERED_DOMAIN`, `METERED_TURN_API_KEY`, and optionally `METERED_REGION=asia`. The API key is from a Metered TURN credential; do not use the account-wide Secret Key and never commit either key to GitHub.

Endpoints:
- `GET /health`
- `GET /ice-config`
- PeerJS signaling under `/peerjs`
