import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { brandingApi } from '../api/settings';
import defaultLogo from '../assets/default-logo.svg';

export const APP_NAME = 'Pragati Car';

const BrandingContext = createContext(null);

/** Draws the logo (any format, SVG included) onto a canvas and makes it the window icon. */
async function updateWindowIcon(url) {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const scale = Math.min(256 / img.naturalWidth, 256 / img.naturalHeight) || 1;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (256 - w) / 2, (256 - h) / 2, w, h);
    await brandingApi.setWindowIcon(canvas.toDataURL('image/png'));
  } catch {
    // The window keeps its default icon.
  }
}

/**
 * Logo + startup sound (files in data/branding, available before the DB opens) and the
 * business name (DB setting, loaded once the DB is ready via setBusinessName).
 */
export function BrandingProvider({ children }) {
  const [files, setFiles] = useState({ logo_url: null, sound_url: null, loaded: false });
  const [businessName, setBusinessName] = useState(APP_NAME);

  const apply = useCallback((result) => setFiles({ ...result, loaded: true }), []);

  useEffect(() => {
    brandingApi
      .get()
      .then(apply)
      .catch(() => setFiles((f) => ({ ...f, loaded: true })));
  }, [apply]);

  const logoUrl = files.logo_url || defaultLogo;
  const isCustomLogo = Boolean(files.logo_url);

  useEffect(() => {
    if (files.loaded) updateWindowIcon(logoUrl);
  }, [files.loaded, logoUrl]);

  const value = useMemo(
    () => ({
      loaded: files.loaded,
      logoUrl,
      isCustomLogo,
      soundUrl: files.sound_url,
      businessName,
      setBusinessName,
      applyFiles: apply,
    }),
    [files, logoUrl, isCustomLogo, businessName, apply],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding() {
  return useContext(BrandingContext);
}
