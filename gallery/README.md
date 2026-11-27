# BGX gallery

Wallpapers the BGX app offers to download (Gallery page). `index.json` lists them:
`id`, `name` / `name_ar`, `kind` (Image | Video), `file` and `thumb` URLs, `size` in bytes, `width` × `height`,
`sha256` (the file's SHA-256 in hex — BGX uses it to let the free version play gallery wallpapers in full), and optionally `group` (a set that becomes a playlist, e.g. Day & night with its daily times in `groups`).

To add a wallpaper: put the file in `files/`, a 480×270 picture in `thumbs/`, and an entry in `index.json`.
