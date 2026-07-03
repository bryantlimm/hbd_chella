import React, { useCallback, useEffect, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import * as faceapi from '@vladmandic/face-api';

// ---------------------------------------------------------------------
// Config / asset placeholders
// ---------------------------------------------------------------------
const MODEL_URL = '/models'; // tiny_face_detector weights live here
const FILTER_IMAGE_URL = '/assets/filter.png'; // transparent PNG, e.g. a party hat
const FRAME_IMAGE_URL = '/assets/booth-frame.png'; // transparent PNG strip frame
const LETTER_IMAGE_URL = '/assets/birthday-letter.png'; // pre-designed letter art

const TOTAL_PHOTOS = 3;
const COUNTDOWN_STEP_MS = 800;
const CAMERA_ASPECT_W = 4;
const CAMERA_ASPECT_H = 3;

// Final composite canvas dimensions (wide horizontal card, split in half).
const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 1000;
const HALF_WIDTH = CANVAS_WIDTH / 2;

// ---------------------------------------------------------------------
// Design tokens — one place to tune the whole look.
// ---------------------------------------------------------------------
const COLORS = {
  plum950: '#180B2E', // page backdrop
  plum800: '#2B1A52', // card surface
  plum700: '#3A2570', // borders / hairlines on dark
  cream: '#FFF6E9', // primary light text / paper
  creamDim: 'rgba(255, 246, 233, 0.7)',
  gold: '#FFC53D', // accent / candle
  pink: '#FF4D8D', // primary action
  mint: '#2FE6A7', // success / download
  ink: '#241442', // text on cream (canvas + light UI)
};

// ---------------------------------------------------------------------
// Small pure helpers (kept outside the component - no need to recreate
// them on every render, and easy to unit test in isolation).
// ---------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = encodeURI(src);
  });
}

/** Draws `img` into the (dx, dy, dw, dh) rect using "contain" scaling
 * so the full image is visible with no cropping at all. */
function drawImageContain(ctx, img, dx, dy, dw, dh) {
  const scale = Math.min(dw / img.width, dh / img.height);
  const sw = img.width * scale;
  const sh = img.height * scale;
  const sx = dx + (dw - sw) / 2;
  const sy = dy + (dh - sh) / 2;
  ctx.drawImage(img, 0, 0, img.width, img.height, sx, sy, sw, sh);
}

/** Draws `img` into the (dx, dy, dw, dh) rect using "cover" scaling
 * so the rect is fully filled, cropping the image as needed. */
function drawImageCover(ctx, img, dx, dy, dw, dh) {
  const scale = Math.max(dw / img.width, dh / img.height);
  const sw = img.width * scale;
  const sh = img.height * scale;
  const sx = dx + (dw - sw) / 2;
  const sy = dy + (dh - sh) / 2;
  ctx.drawImage(img, 0, 0, img.width, img.height, sx, sy, sw, sh);
}

function captureCompositePhoto(videoEl, overlayCanvas, targetWidth, targetHeight) {
  const canvas = document.createElement('canvas');
  const captureWidth = videoEl?.videoWidth || targetWidth;
  const captureHeight = videoEl?.videoHeight || targetHeight;
  canvas.width = captureWidth;
  canvas.height = captureHeight;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, captureWidth, captureHeight);

  if (videoEl && videoEl.videoWidth && videoEl.videoHeight) {
    const videoW = videoEl.videoWidth;
    const videoH = videoEl.videoHeight;
    const scale = Math.min(captureWidth / videoW, captureHeight / videoH);
    const drawW = videoW * scale;
    const drawH = videoH * scale;
    const offsetX = (captureWidth - drawW) / 2;
    const offsetY = (captureHeight - drawH) / 2;

    ctx.drawImage(videoEl, offsetX, offsetY, drawW, drawH);
  }

  if (overlayCanvas) {
    ctx.drawImage(overlayCanvas, 0, 0, captureWidth, captureHeight);
  }

  return canvas.toDataURL('image/png');
}

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Small hand-drawn-feeling squiggle underline, used as a decorative
 * accent beneath the headline on the printed letter panel. */
function drawSquiggle(ctx, x, y, w, color, thickness = 4) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const steps = 5;
  const segW = w / steps;
  ctx.moveTo(x, y);
  for (let i = 0; i < steps; i++) {
    const midX = x + segW * (i + 0.5);
    const endX = x + segW * (i + 1);
    const dir = i % 2 === 0 ? -1 : 1;
    ctx.quadraticCurveTo(midX, y + thickness * 2.4 * dir, endX, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Draws a row of small perforation "sprocket" circles — the film-strip
 * motif that ties the live camera view to the printed keepsake. */
function drawPerforations(ctx, x, y, w, count, radius, color) {
  const gap = w / (count - 1);
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.arc(x + gap * i, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Builds the final dual-panel keepsake on a hidden (offscreen) canvas
 * and returns a PNG data URL.
 *
 * LAYOUT MATH
 * -----------
 * The canvas is CANVAS_WIDTH x CANVAS_HEIGHT, split exactly down the
 * middle into two HALF_WIDTH x CANVAS_HEIGHT panels:
 *
 *   x: 0 ────────────── HALF_WIDTH ────────────── CANVAS_WIDTH
 *      |   photo strip   |      birthday letter    |
 *      |   (3 photos)    |         artwork          |
 *
 * LEFT half: three photos are stacked vertically with equal padding
 * and gaps, so each photo's height is derived by dividing the
 * remaining vertical space (after padding + gaps) by TOTAL_PHOTOS.
 * A row of perforation dots runs along the outer edge of the strip,
 * echoing the live camera view, and each frame carries a small
 * "01/02/03" tab like a real instant-camera counter.
 *
 * RIGHT half: a personal note, headed by a small circular portrait
 * (the richellaImg "locket") and a hand-styled headline.
 */
function renderCollage(photoImgs) {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');

  // Base fill — warm paper tone for both panels, kept unified.
  ctx.fillStyle = '#FFF8EF';
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // ---- LEFT PANEL: film strip -----------------------------------
  const stripPadding = 56;
  const gap = 26;
  const photoHeight = (CANVAS_HEIGHT - stripPadding * 2 - gap * (TOTAL_PHOTOS - 1)) / TOTAL_PHOTOS;
  const photoAspect = CAMERA_ASPECT_W / CAMERA_ASPECT_H; // e.g. 4/3
  const photoWidth = photoHeight * photoAspect;
  const leftPanelWidth = stripPadding * 2 + photoWidth + 26;

  // Perforation strip along the outer edge of the film strip.
  const perfCount = 14;
  for (let i = 0; i < perfCount; i++) {
    const py = stripPadding + (i / (perfCount - 1)) * (CANVAS_HEIGHT - stripPadding * 2);
    ctx.fillStyle = 'rgba(36, 20, 66, 0.14)';
    ctx.beginPath();
    ctx.arc(22, py, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  photoImgs.forEach((img, i) => {
    const dx = stripPadding;
    const dy = stripPadding + i * (photoHeight + gap);
    const radius = 20;

    // drop shadow for a slight "printed photo" lift
    ctx.save();
    ctx.shadowColor = 'rgba(36, 20, 66, 0.18)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;
    roundedRectPath(ctx, dx, dy, photoWidth, photoHeight, radius);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedRectPath(ctx, dx, dy, photoWidth, photoHeight, radius);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(dx, dy, photoWidth, photoHeight);
    drawImageContain(ctx, img, dx, dy, photoWidth, photoHeight);
    ctx.restore();

    // thin gold border
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 197, 61, 0.9)';
    ctx.lineWidth = 3;
    roundedRectPath(ctx, dx, dy, photoWidth, photoHeight, radius);
    ctx.stroke();
    ctx.restore();

    // frame counter tab, e.g. "01"
    const tabLabel = `0${i + 1}`;
    ctx.save();
    ctx.font = `700 20px Baloo 2, ui-rounded, sans-serif`;
    ctx.fillStyle = COLORS.ink;
    const tabW = 52;
    const tabH = 30;
    roundedRectPath(ctx, dx + 14, dy + 14, tabW, tabH, 8);
    ctx.fillStyle = COLORS.gold;
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tabLabel, dx + 14 + tabW / 2, dy + 14 + tabH / 2 + 1);
    ctx.restore();
  });

  // Dashed divider with small perforation dots — reinforces the strip motif.
  ctx.save();
  ctx.strokeStyle = 'rgba(36, 20, 66, 0.16)';
  ctx.lineWidth = 2;
  ctx.setLineDash([2, 10]);
  ctx.beginPath();
  ctx.moveTo(leftPanelWidth, 40);
  ctx.lineTo(leftPanelWidth, CANVAS_HEIGHT - 40);
  ctx.stroke();
  ctx.restore();

  // ---- RIGHT PANEL: the letter -----------------------------------
  const rightX = leftPanelWidth;
  const rightW = CANVAS_WIDTH - leftPanelWidth;
  const rightH = CANVAS_HEIGHT;
  const paddingX = 84;
  const contentW = rightW - paddingX * 2;
  const contentCenterX = rightX + rightW / 2;

  let cursorY = 74;

  // Headline accent only; text removed per request.
  drawSquiggle(ctx, contentCenterX - 90, cursorY + 22, 180, COLORS.gold, 4);
  cursorY += 66;

  // Body copy
  const paragraphs = [
    "The person in this photo is someone who's simply fun to be around — the kind who makes ordinary moments a little more memorable just by being there.",
    "She works hard, probably harder than most people realize, and she's always trying to become a better version of herself, even when life doesn't go the way she hopes. She can be surprisingly tough, but beneath that strength is also just a girl who gets tired, overthinks, and sometimes wonders if she's enough.",
    "But if there's one thing she should never doubt, it's this: she is deeply loved. Loved by her friends. Loved by her family, whoever they may be to her. And above all, loved by Jesus. No matter where life takes her or how heavy the days become, she'll never have to walk alone. Long before any of us could call her a friend, Jesus has always been her closest one.",
    "Nineteen is a funny age — your last year as a teenager, standing somewhere between who you've been and who you're becoming. Life won't always be easy, but I know you don't face it alone. Keep walking with God, keep becoming the person He's shaping you to be, and don't forget that you're loved far more than you know.",
    "Sorry for the late surprise. 😆\n— Bryant (ur uncle)",
  ];

  const verse =
    '"Fear not, for I am with you; be not dismayed, for I am your God. I will strengthen you, I will help you, I will uphold you with my righteous right hand." — Isaiah 41:10';

  const bodyFontSize = 21;
  const lineHeight = bodyFontSize * 1.55;
  const paragraphGap = bodyFontSize * 0.9;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  function wrapText(text, font, maxWidth) {
    ctx.font = font;
    const out = [];
    text.split('\n').forEach((section) => {
      const words = section.split(' ');
      let cur = '';
      for (const w of words) {
        const test = cur ? `${cur} ${w}` : w;
        if (ctx.measureText(test).width > maxWidth) {
          if (cur) out.push(cur);
          cur = w;
        } else {
          cur = test;
        }
      }
      if (cur) out.push(cur);
    });
    return out;
  }

  const bodyFont = `400 ${bodyFontSize}px Work Sans, sans-serif`;
  const signatureParaIndex = paragraphs.length - 1;

  paragraphs.forEach((p, idx) => {
    const isSignature = idx === signatureParaIndex;
    const font = isSignature ? `600 ${bodyFontSize}px Work Sans, sans-serif` : bodyFont;
    const lines = wrapText(p, font, contentW);
    ctx.font = font;
    ctx.fillStyle = COLORS.ink;
    lines.forEach((ln) => {
      cursorY += lineHeight;
      ctx.fillText(ln, contentCenterX, cursorY);
    });
    cursorY += paragraphGap;
  });

  // Divider before the verse
  cursorY += 8;
  ctx.save();
  ctx.strokeStyle = 'rgba(36, 20, 66, 0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(contentCenterX - 40, cursorY);
  ctx.lineTo(contentCenterX + 40, cursorY);
  ctx.stroke();
  ctx.restore();
  cursorY += 34;

  const verseFont = `italic 500 ${bodyFontSize - 2}px Work Sans, sans-serif`;
  const verseLines = wrapText(verse, verseFont, contentW - 40);
  ctx.font = verseFont;
  ctx.fillStyle = 'rgba(36, 20, 66, 0.75)';
  verseLines.forEach((ln) => {
    cursorY += lineHeight * 0.92;
    ctx.fillText(ln, contentCenterX, cursorY);
  });

  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------
// Small presentational subcomponents
// ---------------------------------------------------------------------

/** Row of small perforation dots — the film-strip signature motif,
 * shared between the live camera stage and (in spirit) the print. */
function Perforations({ position }) {
  const holes = Array.from({ length: 16 });
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-10 flex justify-between px-4 ${
        position === 'top' ? 'top-2' : 'bottom-2'
      }`}
    >
      {holes.map((_, i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-[#FFF6E9]/70 shadow-sm" />
      ))}
    </div>
  );
}

function LoadingRing({ label }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <div className="h-12 w-12 animate-spin rounded-full border-4 border-[#FFC53D]/25 border-t-[#FFC53D]" />
      <p className="text-sm text-[#FFF6E9]/70">{label}</p>
    </div>
  );
}

function PermissionErrorPanel({ message }) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <div className="text-5xl">🚫📷</div>
      <p className="max-w-sm text-[#FFF6E9]/80">{message}</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-full bg-gradient-to-r from-[#FF4D8D] to-[#FF6FA3] px-6 py-2.5 font-semibold text-white shadow-lg shadow-[#FF4D8D]/30 transition hover:scale-[1.03] active:scale-95"
      >
        Try again
      </button>
    </div>
  );
}

function PhotoCounterDots({ count, total }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-full transition-all duration-300 ${
            i < count ? 'w-5 bg-[#FF4D8D]' : 'bg-[#FFF6E9]/20'
          }`}
        />
      ))}
    </div>
  );
}

/**
 * CameraPanel owns the live webcam feed, the face-filter canvas overlay,
 * and the countdown/flash UI layered on top of it.
 */
function CameraPanel({
  webcamRef,
  stageRef,
  canvasRef,
  phase,
  countdownLabel,
  photosCount,
  modelsLoaded,
  modelError,
  onStart,
  onUserMediaError,
}) {
  const videoConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 960 },
    facingMode: 'user',
  };

  return (
    <div>
      <div
        ref={stageRef}
        className="relative mx-auto w-full overflow-hidden rounded-[1.5rem] bg-black ring-1 ring-[#FFC53D]/25"
        style={{ aspectRatio: `${CAMERA_ASPECT_W} / ${CAMERA_ASPECT_H}` }}
      >
        <Perforations position="top" />
        <Perforations position="bottom" />

        <Webcam
          ref={webcamRef}
          audio={false}
          mirrored
          screenshotFormat="image/jpeg"
          videoConstraints={videoConstraints}
          onUserMediaError={onUserMediaError}
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* Face-filter overlay. Intentionally NOT css-mirrored — see the
            coordinate math inside drawFilterOnCanvas for why. */}
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        {!modelsLoaded && !modelError && (
          <div className="absolute inset-x-0 bottom-8 flex justify-center">
            <span className="rounded-full bg-black/50 px-3 py-1 text-xs font-medium text-[#FFF6E9]/90 backdrop-blur">
              Loading face filter…
            </span>
          </div>
        )}

        {modelError && (
          <div className="absolute inset-x-0 bottom-8 flex justify-center">
            <span className="rounded-full bg-black/50 px-3 py-1 text-xs font-medium text-[#FFF6E9]/80 backdrop-blur">
              Filter unavailable — photos still work fine
            </span>
          </div>
        )}

        {phase === 'countdown' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35">
            <div className="relative flex h-36 w-36 items-center justify-center">
              <span
                key={`ring-${countdownLabel}`}
                className="pb-ring absolute inset-0 rounded-full border-4 border-[#FFC53D]"
                style={{ animationDuration: `${COUNTDOWN_STEP_MS}ms` }}
              />
              <span
                key={countdownLabel}
                className="pb-countdown-pop text-6xl font-extrabold leading-none text-[#FFC53D] drop-shadow-lg"
                style={{ fontFamily: "'Baloo 2', ui-rounded, sans-serif" }}
              >
                {countdownLabel}
              </span>
            </div>
          </div>
        )}

        {phase === 'flash' && (
          <div key={`flash-${photosCount}`} className="pb-flash-anim absolute inset-0 bg-white" />
        )}
      </div>

      <div className="mt-6 flex flex-col items-center gap-4">
        <PhotoCounterDots count={photosCount} total={TOTAL_PHOTOS} />

        <button
          type="button"
          onClick={onStart}
          disabled={phase !== 'ready'}
          className="rounded-full bg-gradient-to-r from-[#FF4D8D] to-[#FF6FA3] px-8 py-3 text-lg font-semibold text-white shadow-lg shadow-[#FF4D8D]/30 transition hover:scale-[1.03] hover:shadow-xl hover:shadow-[#FF4D8D]/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100 disabled:hover:shadow-lg"
        >
          {photosCount === 0 ? 'Take photo' : `Next photo (${photosCount}/${TOTAL_PHOTOS})`}
        </button>
      </div>
    </div>
  );
}

function StitchingPanel() {
  return <LoadingRing label="Printing your keepsake…" />;
}

function CollagePreviewPanel({ image, onDownload, onStartOver }) {
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="relative w-full max-w-2xl -rotate-1 rounded-2xl bg-[#FFF6E9] p-2 shadow-2xl transition hover:rotate-0">
        <img
          src={image}
          alt="Your birthday photobooth keepsake"
          className="h-auto w-full rounded-xl"
        />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={onDownload}
          className="rounded-full bg-gradient-to-r from-[#2FE6A7] to-[#28D19A] px-7 py-3 font-semibold text-[#181033] shadow-lg shadow-[#2FE6A7]/30 transition hover:scale-[1.03] active:scale-95"
        >
          Download ⬇
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="rounded-full border border-[#FFF6E9]/25 px-7 py-3 font-semibold text-[#FFF6E9]/90 transition hover:bg-[#FFF6E9]/10 active:scale-95"
        >
          Start over
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------

export default function BirthdayPhotobooth() {
  const webcamRef = useRef(null);
  const stageRef = useRef(null); // wraps the video + overlay canvas
  const overlayCanvasRef = useRef(null);
  const filterImageRef = useRef(null);
  const rafIdRef = useRef(null);

  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelError, setModelError] = useState(null);
  const [cameraError, setCameraError] = useState(null);

  // phase: 'loading' | 'ready' | 'countdown' | 'flash' | 'stitching' | 'done'
  const [phase, setPhase] = useState('loading');
  const [countdownLabel, setCountdownLabel] = useState('3');
  const [photos, setPhotos] = useState([]);
  const [finalImage, setFinalImage] = useState(null);
  const [stitchError, setStitchError] = useState(null);

  // -- Load Google Fonts at runtime (move to index.html in production) --
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700;800&family=Work+Sans:wght@400;500;600;700&display=swap';
    document.head.appendChild(link);
    return () => document.head.removeChild(link);
  }, []);

  // -- Preload the face filter PNG once ---------------------------------
  useEffect(() => {
    const img = new Image();
    img.src = FILTER_IMAGE_URL;
    filterImageRef.current = img;
  }, []);

  // -- Load face-api's tiny face detector model on mount ----------------
  useEffect(() => {
    let isMounted = true;

    (async () => {
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        if (isMounted) setModelsLoaded(true);
      } catch (err) {
        console.error('face-api model load failed:', err);
        if (isMounted) {
          setModelError(
            "We couldn't load the face filter models, but you can still take photos."
          );
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  // Once models are loaded (or have failed gracefully), let the user in.
  useEffect(() => {
    if ((modelsLoaded || modelError) && phase === 'loading') {
      setPhase('ready');
    }
  }, [modelsLoaded, modelError, phase]);

  const handleUserMediaError = useCallback((err) => {
    console.error('Webcam permission error:', err);
    setCameraError(
      'We need camera access to run the photobooth. Please allow camera permissions and refresh the page.'
    );
  }, []);

  // -- Draw the face filter onto the overlay canvas ----------------------
  const drawFilterOnCanvas = useCallback((canvas, detection, transform) => {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const filterImg = filterImageRef.current;
    if (!detection || !filterImg || !filterImg.complete || filterImg.naturalWidth === 0) {
      return;
    }

    const { coverScale, offsetX, offsetY } = transform;
    const { x, y, width, height } = detection.box;

    /**
     * STEP 1 — map raw video-pixel coordinates to displayed coordinates.
     * The <video> is rendered with `object-cover`, so it's scaled up and
     * cropped to fill its container. We reproduce that same scale + crop
     * so the box lines up with what's actually on screen:
     *
     *   displayed = (rawVideoPixel * coverScale) - cropOffset
     */
    const displayedX = x * coverScale - offsetX;
    const displayedY = y * coverScale - offsetY;
    const displayedW = width * coverScale;
    const displayedH = height * coverScale;

    /**
     * STEP 2 — account for the mirrored display.
     * The <video> has `mirrored` (CSS scaleX(-1)) so the user sees a
     * natural selfie view, but face-api always detects against the RAW,
     * unmirrored frame. Our overlay <canvas> is deliberately NOT
     * css-mirrored (mirroring the canvas would also flip the filter
     * artwork itself). Instead we flip the box across the canvas's
     * vertical center line ourselves:
     *
     *   mirroredX = canvasWidth - (displayedX + displayedWidth)
     */
    const mirroredX = canvas.width - (displayedX + displayedW);

    // STEP 3 — size + position the filter relative to the face box.
    // The filter should sit above the head rather than in front of the face.
    const filterWidth = displayedW * 1.45;
    const filterHeight = filterWidth * (filterImg.naturalHeight / filterImg.naturalWidth);
    const filterX = mirroredX - (filterWidth - displayedW) / 2;
    const filterY = displayedY - filterHeight * 1.1;

    ctx.drawImage(filterImg, filterX, filterY, filterWidth, filterHeight);
  }, []);

  // -- Continuous face-detection loop ------------------------------------
  useEffect(() => {
    const activePhases = ['ready', 'countdown', 'flash'];
    if (!modelsLoaded || modelError || !activePhases.includes(phase)) {
      return undefined;
    }

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;

      const webcam = webcamRef.current;
      const canvas = overlayCanvasRef.current;
      const stage = stageRef.current;

      if (webcam?.video && webcam.video.readyState === 4 && canvas && stage) {
        const video = webcam.video;
        const containerW = stage.clientWidth;
        const containerH = stage.clientHeight;

        // Keep the canvas's pixel buffer matched to its displayed size.
        if (canvas.width !== containerW || canvas.height !== containerH) {
          canvas.width = containerW;
          canvas.height = containerH;
        }

        // object-cover scale/crop math (video-native px -> displayed px).
        const videoW = video.videoWidth;
        const videoH = video.videoHeight;
        if (videoW && videoH) {
          const coverScale = Math.max(containerW / videoW, containerH / videoH);
          const offsetX = (videoW * coverScale - containerW) / 2;
          const offsetY = (videoH * coverScale - containerH) / 2;

          const detection = await faceapi.detectSingleFace(
            video,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
          );

          if (!cancelled) {
            drawFilterOnCanvas(canvas, detection, { coverScale, offsetX, offsetY });
          }
        }
      }

      if (!cancelled) {
        rafIdRef.current = requestAnimationFrame(tick);
      }
    };

    rafIdRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    };
  }, [modelsLoaded, modelError, phase, drawFilterOnCanvas]);

  // -- Countdown + capture sequence (runs 3 times automatically) --------
  const runCaptureSequence = useCallback(async () => {
    const collected = [];

    for (let shotIndex = 0; shotIndex < TOTAL_PHOTOS; shotIndex++) {
      setPhase('countdown');
      for (let n = 3; n >= 1; n--) {
        setCountdownLabel(String(n));
        // eslint-disable-next-line no-await-in-loop
        await delay(COUNTDOWN_STEP_MS);
      }
      setCountdownLabel('📸');
      await delay(250);

      const screenshot = captureCompositePhoto(
        webcamRef.current?.video,
        overlayCanvasRef.current,
        stageRef.current?.clientWidth || CANVAS_WIDTH,
        stageRef.current?.clientHeight || CANVAS_HEIGHT
      );
      if (screenshot) collected.push(screenshot);
      setPhotos([...collected]);

      setPhase('flash');
      await delay(450);
    }

    setPhase('stitching');
  }, []);

  const handleStartCapture = useCallback(() => {
    if (phase !== 'ready') return;
    setStitchError(null);
    setPhotos([]);
    runCaptureSequence();
  }, [phase, runCaptureSequence]);

  // -- Build the final collage once all 3 photos are in ------------------
  useEffect(() => {
    if (phase !== 'stitching' || photos.length !== TOTAL_PHOTOS) return undefined;

    let cancelled = false;

    (async () => {
      try {
        const photoImgs = await Promise.all(photos.map(loadImage));
        if (cancelled) return;

        const dataUrl = renderCollage(photoImgs);
        setFinalImage(dataUrl);
        setPhase('done');
      } catch (err) {
        console.error('Collage generation failed:', err);
        if (!cancelled) {
          setStitchError('Something went wrong while creating your keepsake. Please try again.');
          setPhase('ready');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, photos]);

  const handleDownload = useCallback(() => {
    if (!finalImage) return;
    const link = document.createElement('a');
    link.href = finalImage;
    link.download = `birthday-photobooth-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [finalImage]);

  const handleStartOver = useCallback(() => {
    setPhotos([]);
    setFinalImage(null);
    setStitchError(null);
    setPhase('ready');
  }, []);

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------
  return (
    <div
      className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden px-4 py-10 text-[#FFF6E9] sm:px-8"
      style={{
        fontFamily: "'Work Sans', ui-sans-serif, system-ui, sans-serif",
        background:
          'radial-gradient(ellipse 80% 60% at 50% -10%, #3A2570 0%, #180B2E 55%), #180B2E',
      }}
    >
      <style>{`
        @keyframes pbCountdownPop {
          0% { transform: scale(0.4); opacity: 0; }
          60% { transform: scale(1.12); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .pb-countdown-pop { animation: pbCountdownPop 0.35s ease-out; }

        @keyframes pbRingBurn {
          0% { transform: scale(0.55); opacity: 0; border-width: 6px; }
          15% { opacity: 1; }
          100% { transform: scale(1); opacity: 0; border-width: 1px; }
        }
        .pb-ring { animation: pbRingBurn linear forwards; }

        @keyframes pbFlash {
          0% { opacity: 0.9; }
          100% { opacity: 0; }
        }
        .pb-flash-anim { animation: pbFlash 0.45s ease-out forwards; }

        @media (prefers-reduced-motion: reduce) {
          .pb-countdown-pop, .pb-ring, .pb-flash-anim { animation-duration: 0.01ms !important; }
        }
      `}</style>

      {/* Ambient sparkle field */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,197,61,0.5) 1px, transparent 1.5px)',
          backgroundSize: '42px 42px',
        }}
      />

      <header className="relative z-10 mb-7 text-center">
        <span className="mb-2 inline-block rounded-full border border-[#FFC53D]/30 bg-[#FFC53D]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#FFC53D]">
          Booth open · take 3
        </span>
        <h1
          className="text-4xl font-extrabold tracking-tight text-[#FFF6E9] sm:text-5xl"
          style={{ fontFamily: "'Baloo 2', ui-rounded, sans-serif" }}
        >
          Richella is <span className="text-[#FFC53D]">19</span>
          <span className="block text-2xl text-[#FF6FA3] sm:text-3xl">— pre-unc era</span>
        </h1>
        <p className="mt-2 text-sm text-[#FFF6E9]/60 sm:text-base">
          HBD Chella... foto dulu sini lol... maap telat
        </p>
      </header>

      <main className="relative z-10 w-full max-w-2xl rounded-[2rem] border border-[#FFF6E9]/10 bg-[#2B1A52]/90 p-5 shadow-2xl backdrop-blur-sm sm:p-8">
        {cameraError ? (
          <PermissionErrorPanel message={cameraError} />
        ) : phase === 'stitching' ? (
          <StitchingPanel />
        ) : phase === 'done' && finalImage ? (
          <CollagePreviewPanel
            image={finalImage}
            onDownload={handleDownload}
            onStartOver={handleStartOver}
          />
        ) : (
          <CameraPanel
            webcamRef={webcamRef}
            stageRef={stageRef}
            canvasRef={overlayCanvasRef}
            phase={phase}
            countdownLabel={countdownLabel}
            photosCount={photos.length}
            modelsLoaded={modelsLoaded}
            modelError={modelError}
            onStart={handleStartCapture}
            onUserMediaError={handleUserMediaError}
          />
        )}

        {stitchError && (
          <p className="mt-4 text-center text-sm text-[#FF4D8D]">{stitchError}</p>
        )}
      </main>

      <footer className="relative z-10 mt-6 text-xs text-[#FFF6E9]/40">Maap telat hehehe</footer>
    </div>
  );
}