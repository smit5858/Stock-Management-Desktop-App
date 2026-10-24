'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

// Files the user adds (logo, startup sound, product images) are copied into data/ and only
// ever referred to by their path RELATIVE to data/ (e.g. 'images/3f2a….jpg').

const LOGO_EXTS = ['png', 'jpg', 'jpeg', 'svg'];
const SOUND_EXTS = ['mp3', 'wav', 'ogg'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const ATTACHMENT_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
const MB = 1024 * 1024;

/** Relative paths that the app-data:// protocol may serve. */
const SERVABLE_RE =
  /^(branding|images|attachments\/tmp|attachments\/(purchases|claims)\/[A-Za-z0-9_-]{1,40})\/[A-Za-z0-9_-]+\.[a-z0-9]{2,4}$/;
const TEMP_ATTACHMENT_RE = /^attachments\/tmp\/[a-f0-9]{16}\.(pdf|png|jpg|jpeg|webp)$/;

function extOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function checkSource(srcFile, exts, maxBytes, what) {
  if (typeof srcFile !== 'string' || !fs.existsSync(srcFile)) {
    throw new AppError(`The selected ${what} file was not found.`, 'NOT_FOUND');
  }
  if (!exts.includes(extOf(srcFile))) {
    throw new AppError(`Please choose a ${exts.join(' / ').toUpperCase()} file.`, 'VALIDATION');
  }
  const size = fs.statSync(srcFile).size;
  if (size > maxBytes) {
    throw new AppError(`The ${what} must be smaller than ${maxBytes / MB} MB.`, 'VALIDATION');
  }
}

/** Copy via a temp file + rename so a pulled USB never leaves a half-written file. */
function copyAtomic(srcFile, destFile) {
  const tmp = `${destFile}.tmp`;
  fs.copyFileSync(srcFile, tmp);
  fs.renameSync(tmp, destFile);
}

function findFixed(dir, base, exts) {
  for (const ext of exts) {
    const file = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(file))
      return { rel: `branding/${base}.${ext}`, mtime: fs.statSync(file).mtimeMs };
  }
  return null;
}

function removeFixed(dir, base, exts) {
  for (const ext of exts) {
    const file = path.join(dir, `${base}.${ext}`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function replaceFixed(paths, srcFile, base, exts) {
  const destFile = path.join(paths.brandingDir, `${base}.${extOf(srcFile)}`);
  copyAtomic(srcFile, `${destFile}.new`);
  removeFixed(paths.brandingDir, base, exts);
  fs.renameSync(`${destFile}.new`, destFile);
}

function getBranding(paths) {
  return {
    logo: findFixed(paths.brandingDir, 'logo', LOGO_EXTS),
    sound: findFixed(paths.brandingDir, 'startup-sound', SOUND_EXTS),
  };
}

function setLogo(paths, srcFile) {
  checkSource(srcFile, LOGO_EXTS, 2 * MB, 'logo');
  replaceFixed(paths, srcFile, 'logo', LOGO_EXTS);
}

function resetLogo(paths) {
  removeFixed(paths.brandingDir, 'logo', LOGO_EXTS);
}

function setSound(paths, srcFile) {
  checkSource(srcFile, SOUND_EXTS, 5 * MB, 'sound');
  replaceFixed(paths, srcFile, 'startup-sound', SOUND_EXTS);
}

function resetSound(paths) {
  removeFixed(paths.brandingDir, 'startup-sound', SOUND_EXTS);
}

/** Copies a product image into data/images/ under a random name. Returns the relative path. */
function saveImage(paths, srcFile) {
  checkSource(srcFile, IMAGE_EXTS, 5 * MB, 'image');
  const name = `${crypto.randomBytes(8).toString('hex')}.${extOf(srcFile)}`;
  copyAtomic(srcFile, path.join(paths.imagesDir, name));
  return `images/${name}`;
}

// ---------------------------------------------------------------- purchase attachments
// Picked files are copied to attachments/tmp/ at once (so a draft can keep them). Saving the
// purchase moves them into attachments/purchases/<entry no>/ inside the save; if the save
// fails, they are moved back.

/** Copies a bill photo / PDF into attachments/tmp/. */
function stageAttachment(paths, srcFile) {
  checkSource(srcFile, ATTACHMENT_EXTS, 15 * MB, 'attachment');
  const dir = path.join(paths.attachmentsDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(8).toString('hex')}.${extOf(srcFile)}`;
  copyAtomic(srcFile, path.join(dir, name));
  return {
    temp_path: `attachments/tmp/${name}`,
    original_name: path.basename(srcFile).slice(0, 120),
    size_bytes: fs.statSync(path.join(dir, name)).size,
  };
}

function isTempAttachment(rel) {
  return typeof rel === 'string' && TEMP_ATTACHMENT_RE.test(rel);
}

/** Folder name for a document number: "PUR/26-0001" → "PUR-26-0001". */
function docFolder(docNo) {
  return (
    String(docNo)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 40) || 'doc'
  );
}

function abs(paths, rel) {
  return path.join(paths.dataDir, ...rel.split('/'));
}

const ATTACHMENT_KINDS = ['purchases', 'claims'];

/**
 * Moves staged attachments into attachments/<kind>/<folder>/ (kind: purchases | claims).
 * Returns the moves done ({ from, to } relative paths) so the caller can undo them if its
 * transaction fails.
 */
function commitAttachments(paths, tempPaths, docNo, kind = 'purchases') {
  if (!ATTACHMENT_KINDS.includes(kind)) throw new Error(`Unknown attachment kind ${kind}`);
  const folder = docFolder(docNo);
  const moves = [];
  try {
    for (const rel of tempPaths) {
      if (!isTempAttachment(rel)) throw new AppError('Invalid attachment.', 'VALIDATION');
      if (!fs.existsSync(abs(paths, rel))) {
        throw new AppError('An attached file is missing. Please attach it again.', 'NOT_FOUND');
      }
      fs.mkdirSync(path.join(paths.attachmentsDir, kind, folder), { recursive: true });
      const to = `attachments/${kind}/${folder}/${path.basename(rel)}`;
      fs.renameSync(abs(paths, rel), abs(paths, to));
      moves.push({ from: rel, to });
    }
  } catch (err) {
    undoAttachmentMoves(paths, moves);
    throw err;
  }
  return moves;
}

function undoAttachmentMoves(paths, moves) {
  for (const m of [...moves].reverse()) {
    try {
      fs.renameSync(abs(paths, m.to), abs(paths, m.from));
    } catch {
      // Best effort: the file stays where it is.
    }
  }
}

/** Resolves a relative data path for serving; null if it is not an allowed path. */
function resolveServable(paths, rel) {
  if (typeof rel !== 'string' || !SERVABLE_RE.test(rel)) return null;
  const file = path.join(paths.dataDir, ...rel.split('/'));
  return fs.existsSync(file) ? file : null;
}

function isValidImagePath(rel) {
  return typeof rel === 'string' && rel.startsWith('images/') && SERVABLE_RE.test(rel);
}

module.exports = {
  LOGO_EXTS,
  SOUND_EXTS,
  IMAGE_EXTS,
  getBranding,
  setLogo,
  resetLogo,
  setSound,
  resetSound,
  saveImage,
  ATTACHMENT_EXTS,
  stageAttachment,
  isTempAttachment,
  commitAttachments,
  undoAttachmentMoves,
  docFolder,
  resolveServable,
  isValidImagePath,
};
