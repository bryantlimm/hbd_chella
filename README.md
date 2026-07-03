# Birthday Photobooth — Setup & Run Guide

This is a complete, ready-to-run project. It already works with placeholder
graphics — you just need to swap in your real images and start it up.

## 1. Install Node.js (one-time, skip if you already have it)

Download and install from **https://nodejs.org** (choose the "LTS" version).
This gives your computer the ability to run the project.

## 2. Open a terminal in this folder

- **Mac:** open the `birthday-photobooth` folder in Finder, right-click inside
  it, choose "New Terminal at Folder" (or open Terminal and `cd` to the path).
- **Windows:** open the `birthday-photobooth` folder in File Explorer, click
  the address bar, type `cmd`, press Enter.

## 3. Install the project's dependencies (one-time)

```
npm install
```

This downloads all the packages the app needs. Takes a minute.

## 4. Run it

```
npm run dev
```

The terminal will print a link like `http://localhost:5173`. Open that in
your browser (Chrome recommended). Your browser will ask for camera
permission — allow it.

To stop the app, click back in the terminal and press `Ctrl + C`.

## 5. Add your real photos

Your friend's file used three placeholder images so it would run out of the
box. Swap them out by replacing these files (**keep the exact same names**):

| Replace this file...                | With...                                                        |
|--------------------------------------|-----------------------------------------------------------------|
| `public/assets/filter.png`          | A transparent PNG worn on the face (party hat, glasses, etc.)  |
| `public/assets/booth-frame.png`     | A transparent PNG frame that overlays the photo strip           |
| `public/assets/birthday-letter.png` | The birthday letter/card artwork shown next to the photos       |

Just drag your PNG files into the `public/assets` folder in Finder/File
Explorer, overwriting the placeholders. No code changes needed — refresh the
browser tab and you'll see your new images.

**Tip:** "transparent PNG" means the background is see-through (not white or
colored) — that's what lets the hat sit naturally over your face and the
frame overlay the photos underneath it.

## Notes

- The face-detection files it needs (for placing the hat filter on your
  face) are already included in `public/models`.
- If you ever want to permanently host this online so you don't need to run
  `npm run dev` each time, that's a separate step (e.g. deploying to
  Vercel or Netlify) — just ask if you'd like help with that.
