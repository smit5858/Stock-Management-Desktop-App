# Pragati Car: USB setup

> Draft. The full copy-to-USB guide is written in Phase 9. This page already covers the
> program icon.

## Changing the program (.exe) icon

The icon of `Pragati Car.exe` (the one Windows shows in File Explorer and the taskbar) is
**built into the program file**. Changing the logo in **Settings → Branding** updates the
sidebar, startup screen, window icon and invoices, but **not** the `.exe` file icon. To change
that icon too:

1. Put your logo in the project as an SVG file. The easiest way is to replace
   `src/assets/default-logo.svg` (square, 256 × 256).
2. Run:

   ```
   npm run make-icon
   ```

   This writes `build/icon.ico` (16–256 px), `build/icon.png` and `electron/assets/icon.png`.
   Using a different SVG file: `npx electron scripts/make-icon.cjs path\to\logo.svg`.
   If you already have a `.ico` file, you can copy it to `build/icon.ico` directly instead.

3. Rebuild the program (Phase 9 adds the exact command), then copy the new
   `release/win-unpacked` folder to the USB, **keeping the existing `data` folder**.

Your data is not affected by changing the icon.
