# BEAT BLOOM — latest game + multiplayer server

This repository contains the current itch.io HTML game and the Node.js PeerJS signaling service. The PeerServer handles room discovery/signaling; for players behind restrictive NATs, the game can receive authenticated TURN relay credentials from Metered through the server-side `/ice-config` endpoint.

## Files

- `index.html`, `assets/`, `peer-server-config.js`: upload these as the itch.io HTML game.
- `server/`: deploy this folder as the Render Web Service root directory.

## 1. Update the GitHub repository

1. Download the GitHub ZIP and extract it.
2. Upload the extracted files and folders to the root of your existing `beat-bloom-multiplayer` repository, replacing the old versions.
3. Commit the changes. Do not upload the ZIP file itself.

## 2. Render settings

Open the existing Render Web Service connected to this GitHub repository and set:

| Setting | Value |
|---|---|
| Root Directory | `server` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

After committing the GitHub update, trigger a deploy if auto-deploy is not enabled.

The game is configured for the existing Render hostname `beat-bloom-multiplayer.onrender.com`, with PeerJS mounted at `/peerjs`.

## 3. Enable actual TURN relay (required for networks that block direct P2P)

The code is prepared to request TURN ICE servers, but TURN relay is **not active until you add valid Metered credentials**. The GitHub ZIP intentionally contains no private keys.

1. Create/sign in to a Metered account and create a TURN credential.
2. In the Metered TURN dashboard, copy the credential's API key (the credential-scoped `apiKey`). Also copy the Metered domain shown for the app, such as `your-app-name.metered.live`.
3. In Render → this Web Service → Environment, add:
   - `METERED_DOMAIN` = your Metered domain only, without `https://`.
   - `METERED_TURN_API_KEY` = the TURN credential API key.
   - `METERED_REGION` = `asia` (recommended for Korea) or another supported region.
4. Save changes and redeploy the service.
5. Verify `https://beat-bloom-multiplayer.onrender.com/health`. It should return `ok: true` and `turnRelayConfigured: true`.
6. Verify `https://beat-bloom-multiplayer.onrender.com/ice-config`. It should return `ok: true`, `configured: true`, and authenticated `turn:` / `turns:` ICE entries.

**Do not put the Metered account Secret Key or TURN API key in `index.html`, `peer-server-config.js`, GitHub, or the itch.io ZIP.** Keep them only in Render Environment variables. The server fetches ICE credentials and passes them to the game. Metered may require newly created credentials to propagate for up to two minutes.

If no Metered credentials are configured, `/ice-config` returns `configured: false` and the game falls back to its existing STUN/PeerJS ICE list. This does not guarantee relay connectivity across restrictive mobile networks.

## 4. Update itch.io

Upload the contents of the separate itch.io ZIP as an HTML game. Do not upload the GitHub ZIP or the `server/` folder to the itch.io HTML game.

## 5. Audio and chart changes in this version

- Increased local note-hit sound level (separate from the song clock and multiplayer packets).
- Lowered menu and song playback levels to balance the hit sound.
- Reanalysed the nine supplied tracks using audio-band onset features. Existing chart events are preserved and additional low-band bass accents, mid-band percussion hits, and upper-harmonic melody events are added. The BPM remains a reference grid; audio transients/offbeats are retained.
- The music is a mixed stereo/mono asset, so the analysis approximates instrument roles from frequency bands. It does not perform source separation or lyric transcription.

## Notes

PeerServer is a signaling service, not a TURN relay. TURN traffic is relayed by the Metered TURN network when WebRTC selects a relay candidate. PeerJS and WebRTC APIs are documented at https://peerjs.com/server/getting-started and https://developer.mozilla.org/docs/Web/API/WebRTC_API.

### Updated chart density report

| Track | Chart events | Note heads (including chords) | Hold events |
|---|---:|---:|---:|
| Crystalline Duel | 441 | 465 | 27 |
| Stage Clear Moment | 437 | 468 | 30 |
| 손끝을 스치는 짜릿함 | 439 | 469 | 26 |
| 너와 나의 콤보 | 414 | 448 | 30 |
| 올 퍼펙트 콤보 | 377 | 411 | 23 |
| 잘 따라와 봐 | 237 | 256 | 17 |
| 이 속도 감당할 수 있겠어 | 269 | 284 | 14 |
| 멈추지 않아 | 492 | 535 | 36 |
| 궁궐의 새벽 | 320 | 332 | 21 |

These are generated chart event counts, not a promise of a particular difficulty rating. Please play-test and tune individual sections after upload.
